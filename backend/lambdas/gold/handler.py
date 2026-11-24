"""CAPA GOLD (escenario 3: awswrangler + SQL de Athena).

Gold = datos modelados para el negocio: dimensiones, hechos y agregados.
Aquí la transformación se expresa en SQL (archivos en backend/sql/gold) y se
ejecuta como CTAS ("CREATE TABLE AS SELECT") en Athena. Ventajas: el SQL es
legible por analistas, Athena escala solo y no hay servidores que administrar.

Para cada archivo ``NN_nombre.sql``:
1. Borra la tabla anterior y sus archivos en S3 (CTAS exige carpeta vacía).
2. Ejecuta el CTAS y espera a que termine.

Los archivos se ejecutan en orden numérico porque los agregados dependen de
las dimensiones y hechos creados antes.
"""

from __future__ import annotations

import logging
from pathlib import Path

import awswrangler as wr

from common.settings import get_settings

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SQL_DIR = Path(__file__).resolve().parents[2] / "sql" / "gold"


def list_gold_models() -> list[tuple[str, Path]]:
    """[(nombre_tabla, ruta_sql)] ordenado por prefijo numérico."""
    return [(p.stem.split("_", 1)[1], p) for p in sorted(SQL_DIR.glob("[0-9][0-9]_*.sql"))]


def lambda_handler(event, context):
    settings = get_settings()
    built = []

    for table, sql_path in list_gold_models():
        location = settings.table_uri("gold", table)

        # 1) Limpieza para que el CTAS sea re-ejecutable.
        wr.catalog.delete_table_if_exists(database=settings.gold_db, table=table)
        wr.s3.delete_objects(location)

        # 2) Renderizamos la plantilla SQL con los nombres reales del entorno.
        sql = sql_path.read_text(encoding="utf-8").format(
            gold_db=settings.gold_db,
            silver_db=settings.silver_db,
            location=location,
        )
        wr.athena.start_query_execution(
            sql=sql,
            database=settings.gold_db,
            workgroup=settings.athena_workgroup,
            wait=True,  # lanza excepción si la consulta falla
        )
        logger.info("gold.%s creada", table)
        built.append(table)

    return {"layer": "gold", "engine": "athena-ctas", "tables": built}
