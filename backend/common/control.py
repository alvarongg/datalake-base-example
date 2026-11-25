"""Estado de control del data lake: ¿qué está al día y qué no?

Un pipeline real no solo transforma datos: también sabe CUÁNDO una tabla puede
procesarse. Este módulo guarda, por dataset, "con qué versión del archivo se
construyó cada capa" y, con eso, decide si una tabla está al día.

Conceptos
---------
* versión de landing: huella (hash de los ETag de S3) de los archivos subidos.
  Si el usuario sube un archivo distinto, la versión cambia.
* control Bronze : qué versión de landing leyó Bronze.
* control Silver : qué versión de Bronze usó y con qué "token" de cada
  dependencia se construyó (``built_from``).
* token Silver   : identifica una construcción concreta de Silver. Si se
  reprocesa una tabla padre, su token cambia y los hijos quedan DESACTUALIZADOS.

Estados de un dataset (``dataset_status``)
------------------------------------------
  no_file  : nunca se cargó y faltan archivos en landing
  pending  : están todos los archivos pero nunca se cargó a Bronze
  bronze   : Bronze al día, falta Silver
  stale    : Silver quedó viejo (llegó un archivo nuevo, o una dependencia cambió)
  ok       : al día; puede usarse como dependencia

Después de cargar Bronze, el CSV se MUEVE a ``archive/`` (ver bronze/handler.py).
Por eso "no hay archivo en landing" no significa "no hay datos": si Bronze ya
se cargó, la tabla sigue al día con la versión que se archivó.

Regla de oro: un dataset solo se procesa en Silver si TODAS sus dependencias
están en estado ``ok``. Si no, el pipeline falla con un mensaje claro.

Todo el estado vive en JSON dentro del bucket de resultados de Athena
(``control/``). El reset vacía ese bucket, así que el estado se reinicia junto
con los datos. Las funciones de decisión son puras (sin AWS) y están testeadas.
"""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

import boto3

from common.datasets import DATASETS, DATASETS_BY_NAME, Dataset
from common.gold_models import GoldModel, load_models
from common.settings import DATASET_PREFIX, Settings

CONTROL_PREFIX = "control"

STATUS_LABELS = {
    "no_file": "nunca se cargó y falta su archivo en landing",
    "pending": "nunca se procesó (no está en Bronze)",
    "bronze": "está en Bronze pero no tiene Silver",
    "stale": "está desactualizada (archivo nuevo o una dependencia cambió)",
    "ok": "al día",
}


class DependencyError(Exception):
    """Una dependencia no está al día: el pipeline debe fallar (y explicar por qué)."""

    def __init__(self, target: str, problems: list[dict]):
        self.problems = problems
        detail = "; ".join(f"{p['dependency']} {p['reason']}" for p in problems)
        super().__init__(f"{target} no se puede procesar: {detail}")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ------------------------------------------------------------ lógica pura


def landing_version(dataset: Dataset, objects: dict[str, dict]) -> str | None:
    """Huella de los archivos del dataset en landing; None si falta alguno."""
    if any(f not in objects for f in dataset.files):
        return None
    raw = "|".join(f"{f}:{objects[f]['etag']}" for f in dataset.files)
    return hashlib.sha1(raw.encode(), usedforsecurity=False).hexdigest()[:12]


def silver_token(control: dict | None) -> str | None:
    return ((control or {}).get("silver") or {}).get("token")


def dataset_status(dataset: Dataset, landing_ver: str | None, controls: dict[str, dict]) -> str:
    ctl = controls.get(dataset.name) or {}
    bronze, silver = ctl.get("bronze"), ctl.get("silver")
    if not bronze:
        return "pending" if landing_ver else "no_file"
    if landing_ver and landing_ver != bronze["version"]:  # llegó un archivo distinto, aún sin procesar
        return "stale"
    if not silver:
        return "bronze"
    if silver["version"] != bronze["version"]:
        return "stale"
    for dep in dataset.depends_on:  # una dependencia se reconstruyó después
        if (silver.get("built_from") or {}).get(dep) != silver_token(controls.get(dep)):
            return "stale"
    return "ok"


def compute_statuses(landing_versions: dict[str, str | None], controls: dict[str, dict]) -> dict[str, str]:
    return {d.name: dataset_status(d, landing_versions.get(d.name), controls) for d in DATASETS}


def check_dependencies(name: str, statuses: dict[str, str]) -> list[dict]:
    """Dependencias de ``name`` que NO están al día (lista vacía = puede procesarse)."""
    return [
        {"dependency": dep, "status": statuses[dep], "reason": STATUS_LABELS[statuses[dep]]}
        for dep in DATASETS_BY_NAME[name].depends_on
        if statuses[dep] != "ok"
    ]


def gold_model_status(model: GoldModel, entry: dict | None, controls: dict[str, dict],
                      gold_entries: dict[str, dict]) -> str:
    """not_built | stale | ok, según los tokens con que se construyó el modelo."""
    if not entry:
        return "not_built"
    built = entry.get("built_from") or {}
    for s in model.silver_deps:
        if built.get(f"silver:{s}") != silver_token(controls.get(s)):
            return "stale"
    for g in model.gold_deps:
        if built.get(f"gold:{g}") != (gold_entries.get(g) or {}).get("at"):
            return "stale"
    return "ok"


def gold_blockers(model: GoldModel, silver_statuses: dict[str, str], fresh_gold: set[str]) -> list[dict]:
    """Por qué NO se puede construir un modelo Gold ahora (lista vacía = se puede)."""
    problems = [
        {"dependency": f"silver.{s}", "status": silver_statuses[s], "reason": STATUS_LABELS[silver_statuses[s]]}
        for s in model.silver_deps if silver_statuses[s] != "ok"
    ]
    problems += [
        {"dependency": f"gold.{g}", "status": "not_built", "reason": "no está construida o está desactualizada"}
        for g in model.gold_deps if g not in fresh_gold
    ]
    return problems


# --------------------------------------------------------------- almacén S3


@dataclass
class LakeState:
    landing: dict[str, dict]  # archivo -> {etag, size, lastModified}
    landing_versions: dict[str, str | None]
    controls: dict[str, dict]
    gold_entries: dict[str, dict] = field(default_factory=dict)
    statuses: dict[str, str] = field(default_factory=dict)
    gold_statuses: dict[str, str] = field(default_factory=dict)


class ControlStore:
    def __init__(self, settings: Settings, s3=None):
        self.settings = settings
        self._s3 = s3 or boto3.client("s3")

    def _key(self, name: str) -> str:
        return f"{CONTROL_PREFIX}/{name}.json"

    def read(self, name: str) -> dict | None:
        try:
            body = self._s3.get_object(Bucket=self.settings.athena_results_bucket, Key=self._key(name))["Body"].read()
        except self._s3.exceptions.NoSuchKey:
            return None
        return json.loads(body)

    def write(self, name: str, body: dict) -> None:
        self._s3.put_object(Bucket=self.settings.athena_results_bucket, Key=self._key(name),
                            Body=json.dumps(body).encode(), ContentType="application/json")

    def landing_objects(self) -> dict[str, dict]:
        found = {}
        for page in self._s3.get_paginator("list_objects_v2").paginate(
                Bucket=self.settings.landing_bucket, Prefix=f"{DATASET_PREFIX}/"):
            for o in page.get("Contents", []):
                found[o["Key"].split("/", 1)[1]] = {
                    "etag": o["ETag"].strip('"'), "size": o["Size"], "lastModified": o["LastModified"].isoformat()}
        return found

    def load(self) -> LakeState:
        landing = self.landing_objects()
        versions = {d.name: landing_version(d, landing) for d in DATASETS}
        models = load_models()
        # Lecturas en paralelo: son ~20 objetos pequeños y la web consulta el estado seguido.
        with ThreadPoolExecutor(8) as pool:
            controls = dict(zip([d.name for d in DATASETS], pool.map(lambda d: self.read(d.name) or {}, DATASETS)))
            gold_entries = {m.name: e for m, e in zip(models, pool.map(lambda m: self.read_gold(m.name), models)) if e}
        statuses = compute_statuses(versions, controls)
        gold_statuses = {m.name: gold_model_status(m, gold_entries.get(m.name), controls, gold_entries)
                         for m in models}
        return LakeState(landing, versions, controls, gold_entries, statuses, gold_statuses)

    # -- escritura (un único escritor por archivo: el pipeline de ese dataset) --
    def record_bronze(self, dataset: str, version: str, rows: int, files: dict[str, str] | None = None,
                      archived: list[str] | None = None) -> None:
        """``files``: archivo -> ETag consumido (sirve para reconocer eventos duplicados)."""
        ctl = self.read(dataset) or {"dataset": dataset}
        ctl["bronze"] = {"version": version, "at": now_iso(), "rows": rows,
                         "files": files or {}, "archived": archived or []}
        self.write(dataset, ctl)

    def record_silver(self, dataset: str, built_from: dict[str, str | None], rows: int | None) -> None:
        ctl = self.read(dataset) or {"dataset": dataset}
        bronze = ctl["bronze"]
        at = now_iso()
        ctl["silver"] = {"version": bronze["version"], "at": at, "rows": rows,
                         "token": f"{bronze['version']}@{at}", "built_from": built_from}
        self.write(dataset, ctl)

    # Un archivo por modelo Gold: dos modelos se pueden construir a la vez sin pisarse.
    def read_gold(self, model: str) -> dict | None:
        return self.read(f"gold/{model}")

    def record_gold(self, model: str, built_from: dict[str, str | None]) -> None:
        self.write(f"gold/{model}", {"model": model, "at": now_iso(), "built_from": built_from})
