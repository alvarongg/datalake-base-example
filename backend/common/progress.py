"""Seguimiento de progreso para la web: QUÉ pipeline está procesando CUÁL tabla.

Cómo funciona (simple a propósito):
* Cada dataset tiene su PROPIO archivo ``progress/<dataset>.json`` en el bucket
  de resultados de Athena, con el estado de sus 3 etapas: bronze, dependencies
  y silver. Los pipelines de datasets distintos pueden correr a la vez sin
  pisarse porque cada uno escribe solo su archivo.
* Gold tiene ``progress/gold.json`` con el estado de cada modelo solicitado.
* Cada archivo lleva el ``executionId`` de Step Functions que lo escribió.
* Escribir progreso es "best effort": si falla se registra un warning pero el
  pipeline NO se detiene (el seguimiento nunca debe romper el procesamiento).
* El reset vacía ese bucket, así que también borra el progreso.
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import contextmanager

import boto3

logger = logging.getLogger()

PREFIX = "progress"
DATASET_STAGES = ("bronze", "dependencies", "silver")


def _put(s3, bucket: str, key: str, body: dict) -> None:
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(body, default=str).encode(),
                      ContentType="application/json")
    except Exception:  # noqa: BLE001 - el progreso nunca debe romper el pipeline
        logger.warning("No se pudo escribir el progreso %s", key, exc_info=True)


class _Tracker:
    """Base: un diccionario JSON que se persiste en cada cambio."""

    key: str

    def __init__(self, bucket: str, client=None):
        self.bucket = bucket
        self._s3 = client or boto3.client("s3")
        self.doc: dict = {}

    def flush(self) -> None:
        self.doc["updatedAt"] = time.time()
        _put(self._s3, self.bucket, self.key, self.doc)


class DatasetProgress(_Tracker):
    """Etapas (bronze → dependencies → silver) de UN dataset en UNA ejecución."""

    def __init__(self, bucket: str, dataset: str, execution_id: str | None, engine: str, client=None):
        super().__init__(bucket, client)
        self.dataset, self.key = dataset, f"{PREFIX}/{dataset}.json"
        self.doc = {"dataset": dataset, "executionId": execution_id, "engine": engine,
                    "stages": {s: {"status": "pending"} for s in DATASET_STAGES}}

    @classmethod
    def load(cls, bucket: str, dataset: str, execution_id: str | None, engine: str, client=None):
        """Retoma el archivo de esta ejecución (para que cada Lambda agregue su etapa)."""
        self = cls(bucket, dataset, execution_id, engine, client)
        try:
            body = self._s3.get_object(Bucket=bucket, Key=self.key)["Body"].read()
            existing = json.loads(body)
            if existing.get("executionId") == execution_id:
                self.doc = existing
        except Exception:  # noqa: BLE001 - primera etapa o archivo ausente
            pass
        return self

    def reset(self) -> None:
        """Marca todas las etapas como pendientes (el dataset está 'en cola')."""
        self.doc["queuedAt"] = time.time()
        self.flush()

    @contextmanager
    def stage(self, name: str):
        """``with progress.stage("bronze") as info: ...; info["rows"] = n``"""
        info: dict = {}
        st = self.doc["stages"][name]
        st.clear()
        st.update(status="running", startedAt=time.time())
        self.flush()
        try:
            yield info
        except Exception as exc:
            st.update(status="failed", finishedAt=time.time(), error=str(exc)[:600], **info)
            self.flush()
            raise
        st.update(status="succeeded", finishedAt=time.time(), **info)
        self.flush()

    def rows(self, stage: str) -> int | None:
        return self.doc["stages"].get(stage, {}).get("rows")


class GoldProgress(_Tracker):
    """Estado de los modelos Gold pedidos en UNA ejecución."""

    key = f"{PREFIX}/gold.json"

    def __init__(self, bucket: str, execution_id: str | None, names: list[str], client=None):
        super().__init__(bucket, client)
        self.doc = {"stage": "gold", "executionId": execution_id,
                    "tables": [{"name": n, "status": "pending"} for n in names]}
        self._by_name = {t["name"]: t for t in self.doc["tables"]}

    def block(self, name: str, error: str, problems: list[dict]) -> None:
        self._by_name[name].update(status="blocked", error=error[:600], detail=problems)
        self.flush()

    @contextmanager
    def table(self, name: str):
        t = self._by_name[name]
        t.update(status="running", startedAt=time.time())
        self.flush()
        try:
            yield
        except Exception as exc:
            t.update(status="failed", finishedAt=time.time(), error=str(exc)[:600])
            self.flush()
            raise
        t.update(status="succeeded", finishedAt=time.time())
        self.flush()
