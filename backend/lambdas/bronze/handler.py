"""CAPA BRONZE - Lambda con pandas + awswrangler (un dataset por ejecución).

Objetivo de Bronze: guardar el dato EXACTAMENTE como llegó, sin interpretarlo,
en un formato eficiente (Parquet) y consultable (tabla en Glue Catalog).

Pasos para el dataset recibido (``event["dataset"]``):
1. Verificar que estén TODOS sus CSV en el bucket ``landing``.
2. Leer cada CSV como texto (``dtype=str``) con su encoding correcto.
3. Agregar columnas de auditoría (_source_file, _ingested_at).
4. Escribir Parquet en el bucket ``bronze`` y registrar la tabla en Glue.
5. Anotar en el control con QUÉ versión del archivo se cargó (lineage).

Bronze no depende de otras tablas: es copia cruda, se puede cargar en cualquier orden.
Idempotente: ``mode="overwrite"`` reemplaza la tabla completa.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import awswrangler as wr
import pandas as pd

from common.control import ControlStore, landing_version
from common.datasets import DATASETS_BY_NAME
from common.progress import DatasetProgress
from common.settings import get_settings
from common.transforms import to_bronze

logger = logging.getLogger()
logger.setLevel(logging.INFO)


class MissingFilesError(Exception):
    """Faltan archivos en landing; el pipeline no debe continuar a medias."""


def lambda_handler(event, context):
    settings = get_settings()
    ds = DATASETS_BY_NAME[event["dataset"]]
    progress = DatasetProgress.load(settings.athena_results_bucket, ds.name,
                                    event.get("executionId"), ds.silver_engine)
    store = ControlStore(settings)
    ingested_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with progress.stage("bronze") as info:  # running -> succeeded/failed
        # 1) Fallar rápido y con un mensaje claro si falta algún archivo.
        landing = store.landing_objects()
        version = landing_version(ds, landing)
        if version is None:
            missing = [f for f in ds.files if f not in landing]
            raise MissingFilesError(f"{ds.name}: faltan archivos en landing: {', '.join(missing)}")

        # 2-3) Leer y agregar auditoría.
        frames = []
        for filename in ds.files:
            # dtype=str + keep_default_na=False: no dejamos que pandas "interprete"
            # nada (ni fechas, ni números, ni 'NA' como nulo). Eso es trabajo de Silver.
            raw = wr.s3.read_csv(settings.landing_uri(filename), dtype=str,
                                 keep_default_na=False, encoding=ds.encoding)
            frames.append(to_bronze(raw, source_file=filename, ingested_at=ingested_at))
        bronze_df = pd.concat(frames, ignore_index=True)

        # 4) Parquet + tabla en el catálogo.
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

        # 5) Control: esta carga corresponde a la versión de landing leída.
        store.record_bronze(ds.name, version, len(bronze_df))
        info["rows"] = len(bronze_df)

    logger.info("bronze.%s: %s filas", ds.name, len(bronze_df))
    return {"layer": "bronze", "dataset": ds.name, "rows": len(bronze_df), "files": list(ds.files)}
