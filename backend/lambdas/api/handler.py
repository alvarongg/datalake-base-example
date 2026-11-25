"""API de la web (API Gateway HTTP + Cognito JWT) en una sola Lambda.

Rutas (todas exigen un token de Cognito, lo valida API Gateway antes de llegar aquí):

  GET  /state               -> estado de datasets, modelos Gold, modo, colas y programación
  GET  /events              -> feed de decisiones del despachador event-driven
  GET  /storage             -> cantidad de archivos y peso por ruta de cada bucket
  GET  /storage/objects     -> contenido de un bucket (explorador de la web)
  POST /mode                -> cambia entre event-driven y programado
  POST /upload-url          -> URL prefirmada para subir UN csv directo a S3
  POST /landing/restore     -> devuelve a landing la última versión archivada (dispara eventos reales de S3)
  POST /events/simulate     -> manda un evento de S3 de un archivo que NO está (demuestra el error)
  POST /dlq/redrive         -> reenvía los mensajes de la DLQ final a la cola principal
  POST /pipeline/start      -> (modo programado) ejecuta Step Functions de datasets o de Gold
  POST /schedule/run        -> (modo programado) ejecuta ya el flujo programado completo
  POST /reset               -> borra bronze/silver/gold (y landing si se pide)
  POST /query               -> SELECT de solo lectura en Athena

Los CSV nunca pasan por la API ni por Lambda: el navegador los sube directo a
S3 con la URL prefirmada. Así no hay límite de 6 MB y no se paga cómputo.
"""

from __future__ import annotations

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import boto3
from botocore.config import Config

from common.control import ControlStore
from common.datasets import ALLOWED_FILES, DATASETS, DATASETS_BY_NAME, all_in_order, dependency_closure
from common.events import ARCHIVE_PREFIX, latest_archived
from common.gold_models import load_models
from common.mode import MODES, get_mode, set_mode
from common.progress import PREFIX as PROGRESS_PREFIX
from common.settings import DATASET_PREFIX, get_settings
from common.sql_guard import UnsafeSqlError, validate_select

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# SigV4 explícito: necesario para que las URLs prefirmadas funcionen con buckets cifrados.
_s3 = boto3.client("s3", config=Config(signature_version="s3v4"))
_sfn = boto3.client("stepfunctions")
_athena = boto3.client("athena")
_lambda = boto3.client("lambda")
_sqs = boto3.client("sqs")

UPLOAD_URL_TTL_SECONDS = 300
MAX_ROWS = 100
QUERY_TIMEOUT_SECONDS = 22  # API Gateway corta a los 29 s
EVENT_RUN_IDLE_SECONDS = 15 * 60  # una corrida event-driven sin novedades en 15 min se da por abandonada
SCHEDULE_MINUTES = int(os.environ.get("SCHEDULE_MINUTES", "30"))


class HttpError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra or {}


def _response(status: int, body: dict):
    return {"statusCode": status, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(body, default=str)}


def _json_body(event) -> dict:
    try:
        return json.loads(event.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise HttpError(400, "El cuerpo debe ser JSON válido.") from exc


def _env(name: str) -> str:
    return os.environ[name]


# ------------------------------------------------------------ ejecuciones


def _running(arn: str) -> list[dict]:
    """Ejecuciones RUNNING (con su input) de una máquina de estados."""
    out = []
    for ex in _sfn.list_executions(stateMachineArn=arn, statusFilter="RUNNING", maxResults=10)["executions"]:
        detail = _sfn.describe_execution(executionArn=ex["executionArn"])
        out.append({"arn": ex["executionArn"], "input": json.loads(detail.get("input") or "{}")})
    return out


def _execution_outcome(execution_arn: str) -> tuple[str, str | None]:
    """(estado, causa) de una ejecución; la causa explica por qué falló."""
    ex = _sfn.describe_execution(executionArn=execution_arn)
    cause = None
    if ex["status"] in ("FAILED", "TIMED_OUT", "ABORTED"):
        for page in _sfn.get_paginator("get_execution_history").paginate(executionArn=execution_arn, reverseOrder=True):
            for ev in page["events"]:
                d = next((v for k, v in ev.items() if k.endswith("FailedEventDetails")), None)
                if d:
                    cause = d.get("cause") or d.get("error")
                    break
            if cause:
                break
    return ex["status"], cause


def _outcome(execution_id: str, updated_at: float, outcomes: dict) -> tuple[str, str | None]:
    """Estado de la corrida que escribió un documento de progreso (Step Functions o event-driven)."""
    if execution_id.startswith("evt:"):
        # Event-driven no tiene un "estado de ejecución" central: se infiere por actividad reciente.
        # Sin novedades en 15 min y sin etapa fallida: quedó sin cerrar (p. ej. un evento repetido). No es un fallo.
        idle = time.time() - (updated_at or 0) > EVENT_RUN_IDLE_SECONDS
        return ("ABANDONED", None) if idle else ("RUNNING", None)
    if execution_id not in outcomes:
        try:
            outcomes[execution_id] = _execution_outcome(execution_id)
        except Exception:  # noqa: BLE001
            outcomes[execution_id] = ("UNKNOWN", None)
    return outcomes[execution_id]


def _get_json(bucket: str, key: str):
    try:
        return json.loads(_s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    except _s3.exceptions.NoSuchKey:
        return None
    except Exception:  # noqa: BLE001 - el progreso es opcional
        logger.warning("No se pudo leer %s", key, exc_info=True)
        return None


def _reconcile_dataset_run(doc: dict, outcomes: dict) -> dict:
    """Une el documento de progreso con el estado real de su ejecución."""
    stages = doc["stages"]
    statuses = [s["status"] for s in stages.values()]
    unfinished = any(s in ("running", "pending", "waiting") for s in statuses)
    if "failed" in statuses:
        run_status = "FAILED"
    elif unfinished:
        run_status, cause = _outcome(doc.get("executionId") or "", doc.get("updatedAt", 0), outcomes)
        if run_status == "ABANDONED":
            return {"runStatus": "ABANDONED", "stages": stages}
        if run_status != "RUNNING":
            for s in stages.values():
                if s["status"] in ("running", "waiting"):
                    s.update(status="failed", error=cause or run_status)
            run_status = "FAILED" if run_status != "SUCCEEDED" else "SUCCEEDED"
    else:
        run_status = "SUCCEEDED"
    exec_id = doc.get("executionId") or ""
    return {"executionId": exec_id, "orchestrator": "event" if exec_id.startswith("evt:") else "stepfunctions",
            "runStatus": run_status, "stages": stages, "updatedAt": doc.get("updatedAt"),
            "queued": run_status == "RUNNING" and all(s["status"] == "pending" for s in stages.values())}


def _queues() -> dict:
    """Profundidad de las 3 colas: visibles, en proceso y demoradas (esperando sus 20 s)."""
    out = {}
    for key, env in (("events", "EVENTS_QUEUE_URL"), ("retry", "RETRY_QUEUE_URL"), ("dlq", "DLQ_URL")):
        try:
            attrs = _sqs.get_queue_attributes(QueueUrl=_env(env), AttributeNames=[
                "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"])["Attributes"]
            out[key] = {"visible": int(attrs["ApproximateNumberOfMessages"]), "inFlight": int(attrs["ApproximateNumberOfMessagesNotVisible"]),
                        "delayed": int(attrs["ApproximateNumberOfMessagesDelayed"]), "url": _env(env)}
        except Exception:  # noqa: BLE001
            logger.warning("No se pudo leer la cola %s", key, exc_info=True)
            out[key] = {"visible": 0, "inFlight": 0, "delayed": 0, "error": True}
    return out


def _schedule() -> dict:
    arn = _env("SCHEDULED_STATE_MACHINE_ARN")
    last = _sfn.list_executions(stateMachineArn=arn, maxResults=1)["executions"]
    return {"everyMinutes": SCHEDULE_MINUTES, "lastRun": last[0] if last else None}


def get_state(event):
    settings = get_settings()
    state = ControlStore(settings, _s3).load()
    bucket = settings.athena_results_bucket
    models = load_models()
    with ThreadPoolExecutor(10) as pool:
        ds_docs = dict(zip([d.name for d in DATASETS], pool.map(lambda d: _get_json(bucket, f"{PROGRESS_PREFIX}/{d.name}.json"), DATASETS)))
        gold_docs = dict(zip([m.name for m in models], pool.map(lambda m: _get_json(bucket, f"{PROGRESS_PREFIX}/gold/{m.name}.json"), models)))
        queues_f = pool.submit(_queues)
        schedule_f = pool.submit(_schedule)
        mode_f = pool.submit(get_mode, None, False)
        running_f = {k: pool.submit(_running, _env(env)) for k, env in (
            ("datasets", "DATASET_STATE_MACHINE_ARN"), ("gold", "GOLD_STATE_MACHINE_ARN"), ("scheduled", "SCHEDULED_STATE_MACHINE_ARN"))}
    outcomes: dict = {}

    datasets = []
    for d in DATASETS:
        ctl = state.controls.get(d.name) or {}
        doc = ds_docs.get(d.name)
        run = _reconcile_dataset_run(doc, outcomes) if doc else None
        if run and (run["runStatus"] == "ABANDONED"
                    or (run["runStatus"] != "RUNNING" and all(s["status"] == "pending" for s in run["stages"].values()))):
            run = None  # estuvo en cola y la ejecución se cortó: no hay nada que mostrar
        bronze = ctl.get("bronze") or {}
        datasets.append({
            "name": d.name, "description": d.description, "engine": d.silver_engine,
            "dependsOn": list(d.depends_on),
            "files": [{"name": f, "uploaded": f in state.landing, "size": (state.landing.get(f) or {}).get("size")} for f in d.files],
            "status": state.statuses[d.name],
            "rows": {"bronze": bronze.get("rows"), "silver": (ctl.get("silver") or {}).get("rows")},
            "lastBronzeAt": bronze.get("at"), "archived": bronze.get("archived", []),
            "run": run,
        })

    gold = []
    for m in models:
        doc = gold_docs.get(m.name)
        run = None
        if doc:
            active = doc["status"] in ("pending", "running", "waiting")
            if active:
                st, cause = _outcome(doc.get("executionId") or "", doc.get("updatedAt", 0), outcomes)
                if st == "ABANDONED":
                    doc = None
                elif st != "RUNNING":
                    doc = {**doc, "status": "failed" if doc["status"] != "pending" else "pending", "error": cause or st}
                    active = False
            if doc and (active or doc["status"] != "pending"):
                run = {**doc, "active": active}
        gold.append({"name": m.name, "silverDeps": list(m.silver_deps), "goldDeps": list(m.gold_deps),
                     "status": state.gold_statuses[m.name], "run": run})

    queues = queues_f.result()
    running_machines = {k: bool(f.result()) for k, f in running_f.items()}
    queue_activity = sum(q["visible"] + q["inFlight"] + q["delayed"] for k, q in queues.items() if k != "dlq")
    event_active = any(d["run"] and d["run"]["orchestrator"] == "event" and d["run"]["runStatus"] == "RUNNING" for d in datasets) \
        or any(g["run"] and g["run"].get("active") for g in gold)
    return 200, {
        "datasets": datasets, "gold": gold, "mode": mode_f.result(), "queues": queues, "schedule": schedule_f.result(),
        "runningMachines": running_machines,
        "running": any(running_machines.values()) or queue_activity > 0 or event_active,
        "ready": all(f in state.landing for f in ALLOWED_FILES),
    }


def get_events(event):
    feed = _get_json(get_settings().athena_results_bucket, f"{PROGRESS_PREFIX}/events.json") or []
    return 200, {"events": feed}


MAX_LISTED_OBJECTS = 1000


def _lake_buckets() -> dict[str, str]:
    """Etiqueta -> nombre real. Solo estos buckets se pueden explorar desde la web (lista blanca)."""
    s = get_settings()
    return {"landing": s.landing_bucket, "bronze": s.bronze_bucket, "silver": s.silver_bucket,
            "gold": s.gold_bucket, "athena-results": s.athena_results_bucket}


def list_objects(event):
    """Contenido de UN bucket (o de una ruta dentro de él) para el explorador de la web."""
    params = event.get("queryStringParameters") or {}
    label, prefix = params.get("bucket", "landing"), params.get("prefix", "")
    buckets = _lake_buckets()
    if label not in buckets:
        raise HttpError(400, f"bucket debe ser uno de: {', '.join(buckets)}.")
    if len(prefix) > 300 or ".." in prefix or prefix.startswith("/"):
        raise HttpError(400, "Ruta inválida.")
    objects = []
    for page in _s3.get_paginator("list_objects_v2").paginate(
            Bucket=buckets[label], Prefix=prefix, PaginationConfig={"MaxItems": MAX_LISTED_OBJECTS + 1}):
        for o in page.get("Contents", []):
            objects.append({"key": o["Key"], "size": o["Size"], "lastModified": o["LastModified"].isoformat(),
                            "etag": o["ETag"].strip('"')})
    return 200, {"bucket": label, "name": buckets[label], "prefix": prefix,
                 "objects": objects[:MAX_LISTED_OBJECTS], "truncated": len(objects) > MAX_LISTED_OBJECTS,
                 "generatedAt": datetime.now(timezone.utc).isoformat()}


def get_storage(event):
    """Cantidad de archivos y peso por ruta (hasta 3 niveles) de cada bucket del lake."""
    buckets = _lake_buckets()

    def scan(item):
        label, name = item
        prefixes: dict[str, dict] = {}
        total = {"files": 0, "bytes": 0}
        for page in _s3.get_paginator("list_objects_v2").paginate(Bucket=name, PaginationConfig={"MaxItems": 20000}):
            for o in page.get("Contents", []):
                parts = o["Key"].split("/")[:-1]
                total["files"] += 1
                total["bytes"] += o["Size"]
                for depth in range(1, min(3, len(parts)) + 1):
                    p = "/".join(parts[:depth]) + "/"
                    e = prefixes.setdefault(p, {"prefix": p, "depth": depth, "files": 0, "bytes": 0, "lastModified": None})
                    e["files"] += 1
                    e["bytes"] += o["Size"]
                    lm = o["LastModified"].isoformat()
                    e["lastModified"] = max(e["lastModified"] or lm, lm)
        return {"label": label, "bucket": name, **total, "prefixes": sorted(prefixes.values(), key=lambda e: e["prefix"])}

    with ThreadPoolExecutor(5) as pool:
        return 200, {"buckets": list(pool.map(scan, buckets.items())), "generatedAt": datetime.now(timezone.utc).isoformat()}


# ----------------------------------------------------------------- modo


def change_mode(event):
    mode = _json_body(event).get("mode")
    if mode not in MODES:
        raise HttpError(400, f"mode debe ser uno de {', '.join(MODES)}.")
    if any(_running(_env(e)) for e in ("DATASET_STATE_MACHINE_ARN", "GOLD_STATE_MACHINE_ARN", "SCHEDULED_STATE_MACHINE_ARN")):
        raise HttpError(409, "Hay una ejecución de Step Functions en curso. Espera a que termine para cambiar de modo.")
    set_mode(mode)
    resent = []
    if mode == "event":
        # Los archivos que esperaban en landing (modo programado) se procesan ahora: se re-emite su evento.
        landing = ControlStore(get_settings(), _s3).landing_objects()
        for name, obj in landing.items():
            if name in ALLOWED_FILES:
                _sqs.send_message(QueueUrl=_env("EVENTS_QUEUE_URL"), MessageBody=_s3_event_body(name, obj["etag"], obj["size"]))
                resent.append(name)
    return 200, {"mode": mode, "resentEvents": resent}


def _s3_event_body(filename: str, etag: str, size: int | None = None) -> str:
    """Mismo formato que la notificación de S3, para que el despachador lo trate igual."""
    return json.dumps({"Records": [{"eventName": "ObjectCreated:Put", "eventTime": datetime.now(timezone.utc).isoformat(),
                                    "s3": {"bucket": {"name": get_settings().landing_bucket},
                                           "object": {"key": f"{DATASET_PREFIX}/{filename}", "eTag": etag, "size": size}}}]})


def _require_mode(expected: str) -> None:
    if get_mode(use_cache=False) != expected:
        other = "event-driven" if expected == "event" else "programado"
        raise HttpError(409, f"Esta acción es del modo {other}. Cambia de modo en la pestaña Operar.")


# ----------------------------------------------------------------- subida


def create_upload_url(event):
    filename = _json_body(event).get("filename", "")
    # Lista blanca: solo los 10 nombres esperados (evita escribir claves arbitrarias).
    if filename not in ALLOWED_FILES:
        raise HttpError(400, f"Archivo no permitido: '{filename}'.")
    s = get_settings()
    url = _s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": s.landing_bucket, "Key": f"{DATASET_PREFIX}/{filename}", "ContentType": "text/csv"},
        ExpiresIn=UPLOAD_URL_TTL_SECONDS,
    )
    return 200, {"url": url, "contentType": "text/csv", "expiresIn": UPLOAD_URL_TTL_SECONDS}


def restore_from_archive(event):
    """Copia a landing la última versión archivada de cada archivo pedido.

    En modo event-driven cada copia genera un evento REAL de S3 → SQS → despachador.
    """
    dataset = _json_body(event).get("dataset", "all")
    names = [d.name for d in DATASETS] if dataset == "all" else [dataset]
    if any(n not in DATASETS_BY_NAME for n in names):
        raise HttpError(400, f"Dataset desconocido: '{dataset}'.")
    s = get_settings()
    keys = [o["Key"] for page in _s3.get_paginator("list_objects_v2").paginate(Bucket=s.landing_bucket, Prefix=f"{ARCHIVE_PREFIX}/")
            for o in page.get("Contents", [])]
    latest = latest_archived(keys)
    files = [f for n in names for f in DATASETS_BY_NAME[n].files]
    missing = [f for f in files if f not in latest]
    if missing and len(missing) == len(files):
        raise HttpError(400, "No hay versiones archivadas de esos archivos. Súbelos en el Paso 1.", {"missingFiles": missing})
    restored = []
    for f in files:
        if f in latest:
            _s3.copy_object(Bucket=s.landing_bucket, Key=f"{DATASET_PREFIX}/{f}", CopySource={"Bucket": s.landing_bucket, "Key": latest[f]},
                            MetadataDirective="REPLACE", ContentType="text/csv", Metadata={"restored-from": latest[f]})
            restored.append({"file": f, "from": latest[f]})
    return 200, {"restored": restored, "missing": missing}


def simulate_missing(event):
    """Evento de S3 de un archivo que NO está en landing: el despachador debe fallar y mandarlo a la DLQ final."""
    _require_mode("event")
    filename = _json_body(event).get("filename", "AdventureWorks_Products.csv")
    if filename not in ALLOWED_FILES:
        raise HttpError(400, f"Archivo no permitido: '{filename}'.")
    landing = ControlStore(get_settings(), _s3).landing_objects()
    if filename in landing:
        raise HttpError(409, f"{filename} sí está en landing: elige uno que no esté para simular el error.")
    _sqs.send_message(QueueUrl=_env("EVENTS_QUEUE_URL"), MessageBody=_s3_event_body(filename, "simulado-sin-archivo", 0))
    return 202, {"sent": filename}


def redrive_dlq(event):
    """Reenvía la DLQ final a la cola principal (SQS StartMessageMoveTask: redrive nativo)."""
    q = _queues()["dlq"]
    if q["visible"] == 0:
        raise HttpError(409, "La DLQ final está vacía.")
    arn = lambda url: _sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]  # noqa: E731
    task = _sqs.start_message_move_task(SourceArn=arn(_env("DLQ_URL")), DestinationArn=arn(_env("EVENTS_QUEUE_URL")))
    return 202, {"taskHandle": task["TaskHandle"], "messages": q["visible"]}


# ---------------------------------------------------------------- pipelines


def plan_dataset_run(dataset: str, mode: str) -> list[str]:
    """Qué datasets hay que procesar, en orden. Función pura (testeada)."""
    if dataset == "all":
        return all_in_order()
    if dataset not in DATASETS_BY_NAME:
        raise HttpError(400, f"Dataset desconocido: '{dataset}'.")
    if mode == "with_dependencies":
        return dependency_closure(dataset)  # lo que necesita + él mismo, en orden
    if mode == "single":
        return [dataset]
    raise HttpError(400, "mode debe ser 'single' o 'with_dependencies'.")


def _busy() -> tuple[set[str], bool, bool]:
    busy_datasets = {i["dataset"] for r in _running(_env("DATASET_STATE_MACHINE_ARN")) for i in r["input"].get("datasets", [])}
    return busy_datasets, bool(_running(_env("GOLD_STATE_MACHINE_ARN"))), bool(_running(_env("SCHEDULED_STATE_MACHINE_ARN")))


def start_pipeline(event):
    _require_mode("scheduled")
    body = _json_body(event)
    kind = body.get("kind", "datasets")
    busy_datasets, gold_busy, scheduled_busy = _busy()
    if scheduled_busy:
        raise HttpError(409, "El flujo programado está en ejecución. Espera a que termine.")

    if kind == "gold":
        models = body.get("models") or []
        known = {m.name for m in load_models()}
        if any(m not in known for m in models):
            raise HttpError(400, "Modelo Gold desconocido.")
        if busy_datasets or gold_busy:
            raise HttpError(409, "Hay pipelines en ejecución. Gold se construye cuando terminan.")
        result = _sfn.start_execution(stateMachineArn=_env("GOLD_STATE_MACHINE_ARN"),
                                      input=json.dumps({"models": models, "onlyStale": False, "onlyReady": False}))
        return 202, {"executionArn": result["executionArn"], "models": models or sorted(known)}

    names = plan_dataset_run(body.get("dataset", ""), body.get("mode", "single"))
    if gold_busy:
        raise HttpError(409, "Se está construyendo Gold. Espera a que termine.")
    clash = sorted(set(names) & busy_datasets)
    if clash:
        raise HttpError(409, f"Ya se está procesando: {', '.join(clash)}.")

    # El sistema EXIGE los archivos de lo que nunca se cargó (lo ya cargado se reutiliza desde Bronze).
    state = ControlStore(get_settings(), _s3).load()
    missing = [f for n in names if state.statuses[n] == "no_file" for f in DATASETS_BY_NAME[n].files if f not in state.landing]
    if missing:
        raise HttpError(400, "Faltan archivos en landing para procesar: " + ", ".join(missing),
                        {"missingFiles": missing, "datasets": names})

    payload = {"datasets": [{"dataset": n, "engine": DATASETS_BY_NAME[n].silver_engine} for n in names]}
    result = _sfn.start_execution(stateMachineArn=_env("DATASET_STATE_MACHINE_ARN"), input=json.dumps(payload))
    return 202, {"executionArn": result["executionArn"], "datasets": names}


def run_schedule_now(event):
    _require_mode("scheduled")
    busy_datasets, gold_busy, scheduled_busy = _busy()
    if busy_datasets or gold_busy or scheduled_busy:
        raise HttpError(409, "Ya hay una ejecución en curso.")
    result = _sfn.start_execution(stateMachineArn=_env("SCHEDULED_STATE_MACHINE_ARN"), input=json.dumps({"manual": True}))
    return 202, {"executionArn": result["executionArn"]}


def reset_lake(event):
    include_landing = bool(_json_body(event).get("includeLanding", False))
    busy_datasets, gold_busy, scheduled_busy = _busy()
    if busy_datasets or gold_busy or scheduled_busy:
        raise HttpError(409, "Hay pipelines en ejecución. Espera a que terminen para reiniciar.")
    q = _queues()
    if any(q[k]["visible"] + q[k]["inFlight"] + q[k]["delayed"] for k in ("events", "retry")):
        raise HttpError(409, "Hay eventos en las colas. Espera a que se vacíen para reiniciar.")
    result = _lambda.invoke(FunctionName=_env("RESET_FUNCTION_NAME"),
                            Payload=json.dumps({"include_landing": include_landing}).encode())
    payload = json.loads(result["Payload"].read())
    if result.get("FunctionError"):
        raise HttpError(500, f"El reset falló: {payload.get('errorMessage', 'error desconocido')}")
    return 200, payload


# ----------------------------------------------------------------- consultas


def run_query(event):
    try:
        sql = validate_select(_json_body(event).get("sql", ""))
    except UnsafeSqlError as exc:
        raise HttpError(400, str(exc)) from exc

    s = get_settings()
    qid = _athena.start_query_execution(
        QueryString=sql, WorkGroup=s.athena_workgroup,
        QueryExecutionContext={"Database": s.gold_db},
    )["QueryExecutionId"]

    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    while True:
        execution = _athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        status = execution["Status"]
        state = status["State"]
        if state == "SUCCEEDED":
            break
        if state in ("FAILED", "CANCELLED"):
            raise HttpError(400, status.get("StateChangeReason", "La consulta falló."))
        if time.monotonic() > deadline:
            _athena.stop_query_execution(QueryExecutionId=qid)
            raise HttpError(504, "La consulta tardó demasiado y fue cancelada.")
        time.sleep(0.5)

    rows = _athena.get_query_results(QueryExecutionId=qid, MaxResults=MAX_ROWS + 1)
    columns = [c["Label"] for c in rows["ResultSet"]["ResultSetMetadata"]["ColumnInfo"]]
    data = [[v.get("VarCharValue") for v in r["Data"]] for r in rows["ResultSet"]["Rows"][1:]]
    stats = execution.get("Statistics", {})
    return 200, {
        "columns": columns, "rows": data[:MAX_ROWS], "truncated": len(data) > MAX_ROWS,
        "queryExecutionId": qid,
        # Métricas que permiten comparar modelos: bytes leídos y tiempo del motor.
        "stats": {"dataScannedBytes": stats.get("DataScannedInBytes"),
                  "engineMillis": stats.get("EngineExecutionTimeInMillis"),
                  "totalMillis": stats.get("TotalExecutionTimeInMillis")},
    }


ROUTES = {
    "GET /state": get_state,
    "GET /events": get_events,
    "GET /storage": get_storage,
    "GET /storage/objects": list_objects,
    "POST /mode": change_mode,
    "POST /upload-url": create_upload_url,
    "POST /landing/restore": restore_from_archive,
    "POST /events/simulate": simulate_missing,
    "POST /dlq/redrive": redrive_dlq,
    "POST /pipeline/start": start_pipeline,
    "POST /schedule/run": run_schedule_now,
    "POST /reset": reset_lake,
    "POST /query": run_query,
}


def lambda_handler(event, context):
    route = event.get("routeKey")
    handler = ROUTES.get(route)
    if handler is None:
        return _response(404, {"message": "Ruta no encontrada."})
    try:
        status, body = handler(event)
        return _response(status, body)
    except HttpError as exc:
        return _response(exc.status, {"message": exc.message, **exc.extra})
    except Exception:  # noqa: BLE001 - no filtramos detalles internos al cliente
        logger.exception("Error no controlado en %s", route)
        return _response(500, {"message": "Error interno."})
