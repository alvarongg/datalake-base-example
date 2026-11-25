"""CAPA BRONZE - pandas + awswrangler (un dataset por ejecución).

Objetivo de Bronze: guardar el dato EXACTAMENTE como llegó, sin interpretarlo,
en un formato eficiente (Parquet) y consultable (tabla en Glue Catalog).

Pasos para el dataset recibido:
1. Verificar que estén TODOS sus CSV en el bucket ``landing``.
2. Leer cada CSV como texto (``dtype=str``) con su encoding correcto.
3. Agregar columnas de auditoría (_source_file, _ingested_at).
4. Escribir Parquet en el bucket ``bronze`` y registrar la tabla en Glue.
5. Anotar en el control con QUÉ versión del archivo se cargó (lineage).
6. MOVER cada CSV de ``landing/adventureworks/`` a ``landing/archive/adventureworks/``
   con la fecha de procesamiento en el nombre. Landing queda vacío: lo que hay
   ahí es siempre "lo que falta procesar".

La misma función ``run_bronze`` la usan los dos orquestadores:
* Step Functions (modo programado) -> ``lambda_handler`` de este archivo.
* Despachador event-driven         -> ``lambdas/dispatcher/handler.py``.

Bronze no depende de otras tablas: es copia cruda, se puede cargar en cualquier orden.
Idempotente: ``mode="overwrite"`` reemplaza la tabla completa.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import awswrangler as wr
import boto3
import pandas as pd

from common.control import ControlStore, landing_version
from common.datasets import DATASETS_BY_NAME, Dataset
from common.events import archive_key
from common.progress import DatasetProgress
from common.settings import DATASET_PREFIX, Settings, get_settings
from common.transforms import to_bronze

logger = logging.getLogger()
logger.setLevel(logging.INFO)


class MissingFilesError(Exception):
    """Faltan archivos en landing; el pipeline no debe continuar a medias."""


def archive_files(settings: Settings, ds: Dataset, etags: dict[str, str], when: datetime) -> list[str]:
    """Mueve los CSV procesados a archive/ (S3 no tiene "mover": se copia y se borra).

    ``CopySourceIfMatch`` asegura que se archiva exactamente la versión que se
    leyó: si mientras tanto alguien subió un archivo nuevo, ese queda en landing
    y su propio evento lo procesará.
    """
    s3 = boto3.client("s3")
    archived = []
    for f in ds.files:
        src, dst = f"{DATASET_PREFIX}/{f}", archive_key(f, when)
        try:
            s3.copy_object(Bucket=settings.landing_bucket, Key=dst, CopySourceIfMatch=etags[f],
                           CopySource={"Bucket": settings.landing_bucket, "Key": src},
                           MetadataDirective="REPLACE", ContentType="text/csv",
                           Metadata={"processed-at": when.isoformat(), "dataset": ds.name, "source-etag": etags[f]})
        except s3.exceptions.ClientError as exc:
            logger.warning("No se archivó %s (cambió mientras se procesaba): %s", f, exc)
            continue
        s3.delete_object(Bucket=settings.landing_bucket, Key=src)
        archived.append(dst)
    return archived


def run_bronze(settings: Settings, ds: Dataset, progress: DatasetProgress, store: ControlStore,
               *, when_missing: str = "fail") -> dict:
    """Carga un dataset a Bronze y archiva sus CSV.

    ``when_missing``:
      * ``fail``           -> si falta algún CSV, error (event-driven y primera carga).
      * ``skip_if_loaded`` -> si NO hay ningún CSV nuevo pero Bronze ya se cargó antes,
                              se reutiliza (modo programado: corre aunque no haya archivos nuevos).
    """
    ingested_at = datetime.now(timezone.utc)
    with progress.stage("bronze") as info:  # running -> succeeded/failed
        # 1) Fallar rápido y con un mensaje claro si falta algún archivo.
        landing = store.landing_objects()
        version = landing_version(ds, landing)
        if version is None:
            present = [f for f in ds.files if f in landing]
            loaded = (store.read(ds.name) or {}).get("bronze")
            if when_missing == "skip_if_loaded" and loaded and not present:
                info.update(skipped=True, rows=loaded.get("rows"),
                            note="Sin archivo nuevo en landing: se reutiliza el Bronze cargado antes.")
                return {"layer": "bronze", "dataset": ds.name, "skipped": True}
            missing = [f for f in ds.files if f not in landing]
            raise MissingFilesError(f"{ds.name}: faltan archivos en landing: {', '.join(missing)}")

        # 2-3) Leer y agregar auditoría.
        frames = []
        for filename in ds.files:
            # dtype=str + keep_default_na=False: no dejamos que pandas "interprete"
            # nada (ni fechas, ni números, ni 'NA' como nulo). Eso es trabajo de Silver.
            raw = wr.s3.read_csv(settings.landing_uri(filename), dtype=str,
                                 keep_default_na=False, encoding=ds.encoding)
            frames.append(to_bronze(raw, source_file=filename, ingested_at=ingested_at.isoformat(timespec="seconds")))
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

        # 5-6) Control (qué versión se cargó) y archivo de los CSV procesados.
        etags = {f: landing[f]["etag"] for f in ds.files}
        archived = archive_files(settings, ds, etags, ingested_at)
        store.record_bronze(ds.name, version, len(bronze_df), files=etags, archived=archived)
        info.update(rows=len(bronze_df), archived=archived)

    logger.info("bronze.%s: %s filas, archivados: %s", ds.name, len(bronze_df), archived)
    return {"layer": "bronze", "dataset": ds.name, "rows": len(bronze_df), "archived": archived}


def lambda_handler(event, context):
    """Entrada desde Step Functions (modo programado)."""
    settings = get_settings()
    ds = DATASETS_BY_NAME[event["dataset"]]
    progress = DatasetProgress.load(settings.athena_results_bucket, ds.name, event.get("executionId"), ds.silver_engine)
    return run_bronze(settings, ds, progress, ControlStore(settings), when_missing="skip_if_loaded")
