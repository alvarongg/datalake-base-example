"""CAPA BRONZE - Lambda con pandas + awswrangler.

Objetivo de Bronze: guardar el dato EXACTAMENTE como llegó, sin interpretarlo,
en un formato eficiente (Parquet) y consultable (tabla en Glue Catalog).

Pasos:
1. Verificar que estén TODOS los CSV esperados en el bucket ``landing``.
2. Leer cada CSV como texto (``dtype=str``) con su encoding correcto.
3. Agregar columnas de auditoría (_source_file, _ingested_at).
4. Escribir Parquet en el bucket ``bronze`` y registrar la tabla en Glue.

Idempotente: ``mode="overwrite"`` reemplaza la tabla completa, así que
ejecutarlo dos veces deja exactamente el mismo resultado.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import awswrangler as wr
import pandas as pd

from common.datasets import DATASETS
from common.settings import get_settings
from common.transforms import to_bronze

logger = logging.getLogger()
logger.setLevel(logging.INFO)


class MissingFilesError(Exception):
    """Faltan archivos en landing; el pipeline no debe continuar a medias."""


def lambda_handler(event, context):
    settings = get_settings()
    ingested_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # 1) Fallar rápido y con un mensaje claro si falta algún archivo.
    missing = [
        f for d in DATASETS for f in d.files
        if not wr.s3.does_object_exist(settings.landing_uri(f))
    ]
    if missing:
        raise MissingFilesError(f"Faltan archivos en landing: {', '.join(sorted(missing))}")

    tables = []
    for ds in DATASETS:
        frames = []
        for filename in ds.files:
            # dtype=str + keep_default_na=False: no dejamos que pandas "interprete"
            # nada (ni fechas, ni números, ni 'NA' como nulo). Eso es trabajo de Silver.
            raw = wr.s3.read_csv(
                settings.landing_uri(filename),
                dtype=str,
                keep_default_na=False,
                encoding=ds.encoding,
            )
            frames.append(to_bronze(raw, source_file=filename, ingested_at=ingested_at))

        bronze_df = pd.concat(frames, ignore_index=True)

        wr.s3.to_parquet(
            df=bronze_df,
            path=settings.table_uri("bronze", ds.name),
            dataset=True,              # escribe como tabla (carpeta de archivos)
            mode="overwrite",          # idempotente: reemplaza el contenido anterior
            database=settings.bronze_db,
            table=ds.name,             # registra/actualiza la tabla en Glue Catalog
            index=False,
            compression="snappy",
            glue_table_settings={"description": f"BRONZE {ds.name}: dato crudo + auditoría. {ds.description}"},
        )
        logger.info("bronze.%s: %s filas", ds.name, len(bronze_df))
        tables.append({"table": ds.name, "rows": len(bronze_df), "files": list(ds.files)})

    return {"layer": "bronze", "ingested_at": ingested_at, "tables": tables}
