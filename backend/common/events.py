"""Piezas de la arquitectura EVENT-DRIVEN (sin AWS: funciones puras, testeadas).

Flujo:

  S3 landing (PUT) ──► SQS "events" ──► Lambda despachador ──► ¿se cumplen las condiciones?
                           ▲                                     │ sí: ejecuta el paso y
                           │                                     │     publica el siguiente
                           │ 20 s                                │ no: espera
                       SQS "retry-dlq" ◄─────────────────────────┘
                           │ (15 intentos agotados o error)
                           ▼
                       SQS "dead-letter" (DLQ final)

Tipos de mensaje que recibe el despachador:
  * ``s3``    -> notificación de S3: llegó un CSV a landing  -> paso Bronze
  * ``glue``  -> EventBridge: un job de Glue terminó         -> cierra Silver (Spark)
  * ``step``  -> mensaje propio: ejecutar Silver o Gold de algo concreto
  * ``test``  -> evento de prueba que S3 manda al configurar la notificación (se ignora)
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from urllib.parse import unquote_plus

from common.control import STATUS_LABELS, gold_blockers
from common.datasets import DATASETS, DATASETS_BY_NAME, Dataset
from common.gold_models import GoldModel, load_models
from common.settings import DATASET_PREFIX

RETRY_DELAY_SECONDS = 20     # lo que espera la DLQ de reintento antes de volver a probar
MAX_ATTEMPTS = 15            # 15 x 20 s = 5 minutos esperando dependencias
LOCK_TTL_SECONDS = 30 * 60   # un job de Glue puede tardar varios minutos
ARCHIVE_PREFIX = f"archive/{DATASET_PREFIX}"
_FILE_TO_DATASET = {f: d for d in DATASETS for f in d.files}


# ------------------------------------------------------------------ mensajes


def parse_messages(body: str) -> list[dict]:
    """Normaliza el cuerpo de un mensaje SQS a una lista de mensajes del pipeline."""
    data = json.loads(body)
    if data.get("Event") == "s3:TestEvent":
        return [{"type": "test"}]
    if "Records" in data:  # notificación de S3 (puede traer varios objetos)
        out = []
        for r in data["Records"]:
            if not r.get("eventName", "").startswith("ObjectCreated"):
                continue
            obj = r["s3"]["object"]
            out.append({"type": "s3", "key": unquote_plus(obj["key"]), "etag": obj.get("eTag", "").strip('"'),
                        "size": obj.get("size"), "eventTime": r.get("eventTime")})
        return out
    if data.get("source") == "aws.glue":  # EventBridge: cambio de estado de un job de Glue
        d = data["detail"]
        return [{"type": "glue", "jobName": d["jobName"], "runId": d["jobRunId"], "state": d["state"], "message": d.get("message")}]
    if data.get("type") == "step":
        return [data]
    raise ValueError(f"Mensaje no reconocido: {body[:200]}")


def step_message(step: str, name: str, trace: str, attempt: int = 0, origin: str = "", **extra) -> dict:
    key = "dataset" if step in ("bronze", "silver") else "model"
    return {"type": "step", "step": step, key: name, "trace": trace, "attempt": attempt, "origin": origin, **extra}


def new_trace(kind: str, name: str, when: datetime | None = None) -> str:
    """Id de ejecución event-driven: agrupa todos los pasos que nacen de un mismo evento."""
    ts = (when or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%S%fZ")
    return f"evt:{kind}:{name}:{ts}"


# ------------------------------------------------------------------- archivos


def dataset_for_key(key: str) -> tuple[str, Dataset | None]:
    """'adventureworks/AdventureWorks_Products.csv' -> ('AdventureWorks_Products.csv', Dataset products)."""
    filename = key.split("/")[-1]
    return filename, _FILE_TO_DATASET.get(filename) if key == f"{DATASET_PREFIX}/{filename}" else None


def archive_key(filename: str, when: datetime) -> str:
    """Ruta en archive/ con la fecha de procesamiento en el nombre.

    AdventureWorks_Products.csv -> archive/adventureworks/AdventureWorks_Products__procesado_20261125T123005Z.csv
    """
    stem, _, ext = filename.rpartition(".")
    return f"{ARCHIVE_PREFIX}/{stem}__procesado_{when.strftime('%Y%m%dT%H%M%SZ')}.{ext}"


_ARCHIVE_RE = re.compile(r"^archive/[^/]+/(?P<stem>.+)__procesado_(?P<ts>\d{8}T\d{6}Z)\.(?P<ext>\w+)$")


def parse_archive_key(key: str) -> tuple[str, str] | None:
    """Inverso de archive_key: (nombre original, timestamp) o None."""
    m = _ARCHIVE_RE.match(key)
    return (f"{m['stem']}.{m['ext']}", m["ts"]) if m else None


def latest_archived(keys: list[str]) -> dict[str, str]:
    """Para cada archivo original, la clave archivada más reciente."""
    best: dict[str, tuple[str, str]] = {}
    for k in keys:
        parsed = parse_archive_key(k)
        if parsed and (parsed[0] not in best or parsed[1] > best[parsed[0]][0]):
            best[parsed[0]] = (parsed[1], k)
    return {name: k for name, (_ts, k) in best.items()}


# --------------------------------------------------------- reglas de decisión
# Cada precheck devuelve (decisión, detalle). Decisiones:
#   ready     -> se cumplen las condiciones: ejecutar el paso
#   waiting   -> falta una condición que puede cumplirse sola: esperar 20 s y reintentar
#   error     -> falta la condición principal: no tiene sentido reintentar
#   skip      -> ya está hecho (evento duplicado o tabla al día): no hacer nada


def bronze_precheck(ds: Dataset, trigger_file: str, trigger_etag: str, landing: dict[str, dict],
                    consumed: dict[str, str]) -> tuple[str, list[str] | str]:
    if trigger_file not in landing:
        if consumed.get(trigger_file) == trigger_etag:
            # Ya se procesó (p. ej. los 3 CSV de ventas: el primer evento cargó los tres).
            return "skip", "el archivo ya se procesó y está en archive/ (evento duplicado)"
        return "error", f"el archivo {trigger_file} no está en landing"
    missing = [f for f in ds.files if f not in landing]
    if missing:
        return "waiting", missing  # p. ej. llegó Sales_2015 pero faltan 2016 y 2017
    return "ready", []


def silver_precheck(name: str, statuses: dict[str, str]) -> tuple[str, list[dict] | str]:
    status = statuses[name]
    if status == "ok":
        return "skip", "la tabla ya está al día"
    if status in ("no_file", "pending"):
        return "skip", "todavía no se cargó en Bronze: su propio archivo disparará el pipeline"
    problems = [{"dependency": d, "status": statuses[d], "reason": STATUS_LABELS[statuses[d]]}
                for d in DATASETS_BY_NAME[name].depends_on if statuses[d] != "ok"]
    return ("waiting", problems) if problems else ("ready", [])


def gold_precheck(model: GoldModel, silver_statuses: dict[str, str], gold_statuses: dict[str, str]) -> tuple[str, list[dict] | str]:
    if gold_statuses.get(model.name) == "ok":
        return "skip", "el modelo ya está al día"
    fresh = {m for m, st in gold_statuses.items() if st == "ok"}
    problems = gold_blockers(model, silver_statuses, fresh)
    return ("waiting", problems) if problems else ("ready", [])


def next_after_silver(name: str, statuses: dict[str, str]) -> tuple[list[str], list[str]]:
    """Qué disparar cuando la tabla Silver ``name`` queda al día.

    * tablas hijas que ya tienen Bronze (y por lo tanto esperan Silver), y
    * modelos Gold que leen esta tabla.
    """
    children = [d.name for d in DATASETS if name in d.depends_on and statuses.get(d.name) in ("bronze", "stale")]
    models = [m.name for m in load_models() if name in m.silver_deps]
    return children, models


def next_after_gold(model: str) -> list[str]:
    return [m.name for m in load_models() if model in m.gold_deps]


# ------------------------------------------------- concurrencia con S3 (sin DB)


def _conflict(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    return code in ("PreconditionFailed", "ConditionalRequestConflict", "412", "409")


class S3Lock:
    """Lock con escritura condicional de S3 (``If-None-Match: *``).

    Dos mensajes de la misma tabla pueden llegar a la vez. Solo uno logra crear
    ``locks/<nombre>.json``; el otro vuelve a la DLQ de reintento. Si el dueño
    murió sin liberar, el lock expira a los ``LOCK_TTL_SECONDS``.
    """

    def __init__(self, s3, bucket: str, name: str, owner: str, ttl: int = LOCK_TTL_SECONDS):
        self.s3, self.bucket, self.owner, self.ttl = s3, bucket, owner, ttl
        self.key = f"locks/{name}.json"

    def acquire(self, now: float) -> bool:
        for _ in range(2):
            try:
                self.s3.put_object(Bucket=self.bucket, Key=self.key, IfNoneMatch="*",
                                   Body=json.dumps({"owner": self.owner, "expires": now + self.ttl}).encode())
                return True
            except Exception as exc:  # noqa: BLE001
                if not _conflict(exc):
                    raise
                try:
                    current = json.loads(self.s3.get_object(Bucket=self.bucket, Key=self.key)["Body"].read())
                except Exception:  # noqa: BLE001 - lo liberaron entre medio: reintentar
                    continue
                if current.get("owner") == self.owner:
                    return True  # reentrante: el mismo flujo ya lo tiene
                if current.get("expires", 0) > now:
                    return False
                self.s3.delete_object(Bucket=self.bucket, Key=self.key)  # expirado: se libera y se reintenta
        return False

    def release(self) -> None:
        self.s3.delete_object(Bucket=self.bucket, Key=self.key)


def append_feed(s3, bucket: str, entry: dict, key: str = "progress/events.json", max_entries: int = 100) -> None:
    """Agrega una línea al feed de eventos con concurrencia optimista (``If-Match`` del ETag)."""
    for _ in range(6):
        try:
            obj = s3.get_object(Bucket=bucket, Key=key)
            etag, data = obj["ETag"], json.loads(obj["Body"].read())
        except Exception as exc:  # noqa: BLE001
            if "NoSuchKey" not in type(exc).__name__ and "NoSuchKey" not in str(exc):
                raise
            etag, data = None, []
        data = ([entry] + data)[:max_entries]
        cond = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
        try:
            s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(data, default=str).encode(),
                          ContentType="application/json", **cond)
            return
        except Exception as exc:  # noqa: BLE001
            if not _conflict(exc):
                raise
