"""CAPA GOLD (escenario 3: awswrangler + SQL de Athena).

Gold = datos modelados para el negocio: dimensiones, hechos y agregados.
Aquí la transformación se expresa en SQL (archivos en backend/sql/gold) y se
ejecuta como CTAS ("CREATE TABLE AS SELECT") en Athena. Ventajas: el SQL es
legible por analistas, Athena escala solo y no hay servidores que administrar.

Antes de construir se aplica la misma regla de dependencias que en Silver:

* cada tabla Silver que el SQL lee debe estar ``ok`` (al día);
* cada modelo Gold que el SQL lee debe estar construido y al día (o construirse
  antes, en esta misma ejecución).

Opciones del pedido (``event["request"]``, lo arma la API o el flujo programado):
* ``models``     -> lista de modelos (vacía = todos).
* ``onlyStale``  -> saltear modelos que ya están al día (el flujo programado no
                    rehace trabajo).
* ``onlyReady``  -> construir lo que se pueda y saltear lo bloqueado en vez de fallar.

Sin ``onlyReady``, si algo no se cumple la ejecución FALLA antes de tocar nada.
``build_model`` la usan Step Functions y el despachador event-driven.
"""

from __future__ import annotations

import logging

import awswrangler as wr

from common.control import ControlStore, DependencyError, LakeState, gold_blockers, silver_token
from common.gold_models import GoldModel, list_gold_models, load_models  # noqa: F401 (list_gold_models: re-export)
from common.progress import GoldProgress
from common.settings import Settings, get_settings

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def plan_models(requested: list[str] | None, all_models, silver_statuses: dict, gold_statuses: dict,
                only_stale: bool = False):
    """Valida el pedido y devuelve (modelos_a_construir, bloqueos_por_modelo, salteados).

    Función pura: no toca AWS, por eso se puede testear en local.
    """
    known = {m.name for m in all_models}
    unknown = [m for m in (requested or []) if m not in known]
    if unknown:
        raise ValueError(f"Modelos Gold desconocidos: {', '.join(unknown)}")
    wanted = [m for m in all_models if not requested or m.name in requested]  # conserva el orden de construcción

    fresh = {name for name, st in gold_statuses.items() if st == "ok"}
    blocked, to_build, skipped = {}, [], []
    for model in wanted:
        rebuilt_parent = any(g in {m.name for m in to_build} for g in model.gold_deps)
        if only_stale and gold_statuses.get(model.name) == "ok" and not rebuilt_parent:
            skipped.append(model.name)
            continue
        problems = gold_blockers(model, silver_statuses, fresh)
        if problems:
            blocked[model.name] = problems
            fresh.discard(model.name)
        else:
            to_build.append(model)
            fresh.add(model.name)  # los modelos siguientes pueden apoyarse en este
    return to_build, blocked, skipped


def build_model(settings: Settings, store: ControlStore, model: GoldModel, state: LakeState) -> None:
    """DROP + CTAS de un modelo y registro de su lineage."""
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
    built_from = {f"silver:{s}": silver_token(state.controls[s]) for s in model.silver_deps}
    built_from.update({f"gold:{g}": (store.read_gold(g) or {}).get("at") for g in model.gold_deps})
    store.record_gold(model.name, built_from)
    logger.info("gold.%s creada", model.name)


def lambda_handler(event, context):
    """Entrada desde Step Functions (manual o programado)."""
    settings = get_settings()
    store = ControlStore(settings)
    req = (event or {}).get("request") or event or {}
    requested = req.get("models") or []
    models = load_models()
    state = store.load()

    to_build, blocked, skipped = plan_models(requested, models, state.statuses, state.gold_statuses,
                                             only_stale=bool(req.get("onlyStale")))
    names = [m.name for m in models if not requested or m.name in requested]
    progress = GoldProgress(settings.athena_results_bucket, (event or {}).get("executionId"), names)
    progress.flush()
    for name in skipped:
        progress.set(name, "succeeded", skipped=True, note="Ya estaba al día")

    for name, problems in blocked.items():
        progress.block(name, f"{name}: " + "; ".join(f"{p['dependency']} {p['reason']}" for p in problems), problems)
    if blocked and not req.get("onlyReady"):
        first = next(iter(blocked))
        raise DependencyError(first, blocked[first])  # falla ANTES de modificar nada

    built = []
    for model in to_build:
        with progress.table(model.name):  # running -> succeeded/failed
            build_model(settings, store, model, state)
        built.append(model.name)

    return {"layer": "gold", "engine": "athena-ctas", "tables": built, "blocked": list(blocked), "skipped": skipped}
