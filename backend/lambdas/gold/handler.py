"""CAPA GOLD (escenario 3: awswrangler + SQL de Athena).

Gold = datos modelados para el negocio: dimensiones, hechos y agregados.
Aquí la transformación se expresa en SQL (archivos en backend/sql/gold) y se
ejecuta como CTAS ("CREATE TABLE AS SELECT") en Athena. Ventajas: el SQL es
legible por analistas, Athena escala solo y no hay servidores que administrar.

Se pueden construir TODOS los modelos o solo algunos (``event["models"]``).
Antes de construir se aplica la misma regla de dependencias que en Silver:

* cada tabla Silver que el SQL lee debe estar ``ok`` (al día);
* cada modelo Gold que el SQL lee debe estar construido y al día (o construirse
  antes, en esta misma ejecución).

Si algo no se cumple, la ejecución FALLA antes de tocar nada y explica qué falta.

Para cada modelo válido:
1. Borra la tabla anterior y sus archivos en S3 (CTAS exige carpeta vacía).
2. Ejecuta el CTAS y espera a que termine.
3. Registra en el control con qué tokens se construyó (lineage).
"""

from __future__ import annotations

import logging

import awswrangler as wr

from common.control import ControlStore, DependencyError, gold_blockers, silver_token
from common.gold_models import list_gold_models, load_models  # noqa: F401 (list_gold_models: re-export)
from common.progress import GoldProgress
from common.settings import get_settings

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def plan_models(requested: list[str] | None, all_models, silver_statuses: dict, gold_statuses: dict):
    """Valida el pedido y devuelve (modelos_a_construir, bloqueos_por_modelo).

    Función pura: no toca AWS, por eso se puede testear en local.
    """
    known = {m.name for m in all_models}
    unknown = [m for m in (requested or []) if m not in known]
    if unknown:
        raise ValueError(f"Modelos Gold desconocidos: {', '.join(unknown)}")
    wanted = [m for m in all_models if not requested or m.name in requested]  # conserva el orden de construcción

    fresh = {name for name, st in gold_statuses.items() if st == "ok"}
    blocked, to_build = {}, []
    for model in wanted:
        problems = gold_blockers(model, silver_statuses, fresh)
        if problems:
            blocked[model.name] = problems
            fresh.discard(model.name)
        else:
            to_build.append(model)
            fresh.add(model.name)  # los modelos siguientes pueden apoyarse en este
    return to_build, blocked


def lambda_handler(event, context):
    settings = get_settings()
    store = ControlStore(settings)
    requested = (event or {}).get("models") or []
    models = load_models()
    state = store.load()

    to_build, blocked = plan_models(requested, models, state.statuses, state.gold_statuses)
    names = [m.name for m in models if not requested or m.name in requested]
    progress = GoldProgress(settings.athena_results_bucket, (event or {}).get("executionId"), names)
    progress.flush()

    if blocked:
        for name, problems in blocked.items():
            progress.block(name, f"{name}: " + "; ".join(f"{p['dependency']} {p['reason']}" for p in problems), problems)
        first = next(iter(blocked))
        raise DependencyError(first, blocked[first])  # falla ANTES de modificar nada

    built = []
    for model in to_build:
        with progress.table(model.name):  # running -> succeeded/failed
            location = settings.table_uri("gold", model.name)

            # 1) Limpieza para que el CTAS sea re-ejecutable.
            wr.catalog.delete_table_if_exists(database=settings.gold_db, table=model.name)
            wr.s3.delete_objects(location)

            # 2) Renderizamos la plantilla SQL con los nombres reales del entorno.
            sql = model.path.read_text(encoding="utf-8").format(
                gold_db=settings.gold_db, silver_db=settings.silver_db, location=location)
            wr.athena.start_query_execution(sql=sql, database=settings.gold_db,
                                            workgroup=settings.athena_workgroup,
                                            wait=True)  # lanza excepción si la consulta falla

            # 3) Lineage: con qué versiones de sus insumos se construyó.
            current = store.read("gold") or {"models": {}}
            built_from = {f"silver:{s}": silver_token(state.controls[s]) for s in model.silver_deps}
            built_from.update({f"gold:{g}": current["models"][g]["at"] for g in model.gold_deps})
            store.record_gold(model.name, built_from)
        logger.info("gold.%s creada", model.name)
        built.append(model.name)

    return {"layer": "gold", "engine": "athena-ctas", "tables": built}
