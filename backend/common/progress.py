"""Seguimiento de progreso para la web: QUÉ pipeline está procesando CUÁL tabla.

Cómo funciona (simple a propósito):
* Cada dataset tiene su PROPIO archivo ``progress/<dataset>.json`` en el bucket
  de resultados de Athena, con el estado de sus 3 etapas: bronze, dependencies
  y silver. Pipelines de datasets distintos pueden correr a la vez sin pisarse
  porque cada uno escribe solo su archivo.
* Cada modelo Gold tiene ``progress/gold/<modelo>.json`` por el mismo motivo.
* Cada archivo lleva el ``executionId`` que lo escribió:
    - ARN de Step Functions en el modo programado;
    - ``evt:<...>`` en el modo event-driven (lo genera el despachador).
* Estados de una etapa: pending | running | waiting | succeeded | failed.
  ``waiting`` solo existe en event-driven: la condición no se cumple todavía y
  el evento espera 20 s en la DLQ de reintento.
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


class DatasetProgress:
    """Etapas (bronze → dependencies → silver) de UN dataset en UNA ejecución."""

    def __init__(self, bucket: str, dataset: str, execution_id: str | None, engine: str, client=None):
        self.bucket, self.dataset = bucket, dataset
        self._s3 = client or boto3.client("s3")
        self.key = f"{PREFIX}/{dataset}.json"
        self.doc: dict = {"dataset": dataset, "executionId": execution_id, "engine": engine,
                          "stages": {s: {"status": "pending"} for s in DATASET_STAGES}}

    @classmethod
    def load(cls, bucket: str, dataset: str, execution_id: str | None, engine: str, client=None):
        """Retoma el archivo de esta ejecución (para que cada paso agregue su etapa)."""
        self = cls(bucket, dataset, execution_id, engine, client)
        try:
            body = self._s3.get_object(Bucket=bucket, Key=self.key)["Body"].read()
            existing = json.loads(body)
            if existing.get("executionId") == execution_id:
                self.doc = existing
        except Exception:  # noqa: BLE001 - primera etapa o archivo ausente
            pass
        return self

    def flush(self) -> None:
        self.doc["updatedAt"] = time.time()
        _put(self._s3, self.bucket, self.key, self.doc)

    def reset(self) -> None:
        """Marca todas las etapas como pendientes (el dataset está 'en cola')."""
        self.doc["queuedAt"] = time.time()
        self.flush()

    def set(self, stage: str, status: str, **info) -> None:
        """Fija el estado de una etapa sin contexto (lo usa el despachador event-driven)."""
        self.doc["stages"][stage] = {"status": status, "at": time.time(), **info}
        self.flush()

    def wait(self, stage: str, attempt: int, max_attempts: int, reason: str, detail: list | None = None) -> None:
        self.set(stage, "waiting", attempt=attempt, maxAttempts=max_attempts, reason=reason, detail=detail or [])

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


class GoldProgress:
    """Estado de los modelos Gold de UNA ejecución (un archivo por modelo)."""

    def __init__(self, bucket: str, execution_id: str | None, names: list[str], client=None):
        self.bucket, self.execution_id = bucket, execution_id
        self._s3 = client or boto3.client("s3")
        self.models = {n: {"model": n, "executionId": execution_id, "status": "pending"} for n in names}

    @staticmethod
    def key(name: str) -> str:
        return f"{PREFIX}/gold/{name}.json"

    def _flush_one(self, name: str) -> None:
        self.models[name]["updatedAt"] = time.time()
        _put(self._s3, self.bucket, self.key(name), self.models[name])

    def flush(self) -> None:
        for n in self.models:
            self._flush_one(n)

    def set(self, name: str, status: str, **info) -> None:
        self.models[name].update(status=status, **info)
        self._flush_one(name)

    def block(self, name: str, error: str, problems: list[dict]) -> None:
        self.set(name, "blocked", error=error[:600], detail=problems)

    @contextmanager
    def table(self, name: str):
        self.set(name, "running", startedAt=time.time())
        try:
            yield
        except Exception as exc:
            self.set(name, "failed", finishedAt=time.time(), error=str(exc)[:600])
            raise
        self.set(name, "succeeded", finishedAt=time.time())
