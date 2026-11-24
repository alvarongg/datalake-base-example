"""CAPA SILVER (escenario 1: pandas) - una tabla pequeña por ejecución, en una Lambda.

Silver = datos limpios, tipados y deduplicados, listos para analizar.
Las tablas chicas (clientes, productos, calendario...) caben de sobra en la
memoria de una Lambda, así que usar pandas es la opción más simple y barata.
Las tablas grandes (ventas, devoluciones) se procesan con Spark en Glue
(ver backend/glue/silver_facts.py).

La lógica de limpieza vive en ``common/transforms.py`` (funciones puras
testeadas). Esta Lambda solo lee Bronze, aplica la función y escribe Silver.
Corre DESPUÉS de la verificación de dependencias.
"""

from __future__ import annotations

import logging

import awswrangler as wr

from common.datasets import DATASETS_BY_NAME
from common.progress import DatasetProgress
from common.settings import get_settings
from common.transforms import SILVER_PANDAS_TRANSFORMS

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    settings = get_settings()
    table = event["dataset"]
    ds = DATASETS_BY_NAME[table]
    transform = SILVER_PANDAS_TRANSFORMS[table]  # KeyError si se pide un dataset de Glue
    progress = DatasetProgress.load(settings.athena_results_bucket, table,
                                    event.get("executionId"), ds.silver_engine)

    with progress.stage("silver") as info:
        # Leemos la tabla Bronze directamente desde S3 (Parquet).
        bronze_df = wr.s3.read_parquet(settings.table_uri("bronze", table), dataset=True)
        # Las columnas de auditoría no pasan a Silver como columnas de negocio.
        bronze_df = bronze_df.drop(columns=["_source_file", "_ingested_at"], errors="ignore")

        silver_df, report = transform(bronze_df)

        wr.s3.to_parquet(
            df=silver_df,
            path=settings.table_uri("silver", table),
            dataset=True,
            mode="overwrite",
            database=settings.silver_db,
            table=table,
            index=False,
            compression="snappy",
            glue_table_settings={"description": f"SILVER {table}: limpio y tipado (pandas)."},
        )
        info.update(rows=report.rows_out, rowsIn=report.rows_in, duplicates=report.duplicates_removed)

    logger.info("silver.%s: %s -> %s filas", table, report.rows_in, report.rows_out)
    return {"layer": "silver", "engine": "pandas", **report.as_dict()}
