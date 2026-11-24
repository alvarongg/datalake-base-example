"""RESET - deja el data lake vacío para poder poblarlo desde cero.

Borra los objetos de Bronze, Silver, Gold y resultados de Athena, y elimina
las tablas del Glue Catalog. Las bases de datos y los buckets (infraestructura)
se conservan. Opcionalmente también vacía ``landing`` (los CSV subidos).

Lo invocan la API (botón de la web) y ``deplo.sh reset``.
Es una operación destructiva a propósito: por eso vive en su propia Lambda,
con permisos de borrado que NO tiene ninguna otra función.
"""

from __future__ import annotations

import logging

import awswrangler as wr
import boto3

from common.settings import get_settings

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.resource("s3")


def _empty_bucket(name: str) -> int:
    deleted = 0
    for page in s3.Bucket(name).objects.page_size(1000).pages():
        keys = [{"Key": o.key} for o in page]
        if keys:
            s3.Bucket(name).delete_objects(Delete={"Objects": keys})
            deleted += len(keys)
    return deleted


def lambda_handler(event, context):
    settings = get_settings()
    include_landing = bool((event or {}).get("include_landing", False))

    buckets = {
        "bronze": settings.bronze_bucket,
        "silver": settings.silver_bucket,
        "gold": settings.gold_bucket,
        "athena_results": settings.athena_results_bucket,
    }
    if include_landing:
        buckets["landing"] = settings.landing_bucket

    # 1) Tablas del catálogo (primero, para no dejar tablas apuntando a nada).
    dropped = {}
    for db in (settings.bronze_db, settings.silver_db, settings.gold_db):
        tables = list(wr.catalog.get_tables(database=db))
        for t in tables:
            wr.catalog.delete_table_if_exists(database=db, table=t["Name"])
        dropped[db] = [t["Name"] for t in tables]

    # 2) Objetos en S3.
    deleted = {layer: _empty_bucket(name) for layer, name in buckets.items()}

    logger.info("reset ok: %s | %s", dropped, deleted)
    return {"tables_dropped": dropped, "objects_deleted": deleted, "landing_included": include_landing}
