"""API de la web (API Gateway HTTP + Cognito JWT) en una sola Lambda.

Rutas (todas exigen un token de Cognito, lo valida API Gateway antes de llegar aquí):

  GET  /state             -> estado de cada dataset y modelo Gold (qué está al día,
                             qué falta, qué se está procesando ahora)
  POST /upload-url        -> URL prefirmada para subir UN csv directo a S3
  POST /pipeline/start    -> inicia un pipeline: de un dataset (solo o con sus
                             dependencias), de todos, o la construcción de Gold
  POST /reset             -> borra bronze/silver/gold (y landing si se pide)
  POST /query             -> SELECT de solo lectura en Athena

Los CSV nunca pasan por la API ni por Lambda: el navegador los sube directo a
S3 con la URL prefirmada. Así no hay límite de 6 MB y no se paga cómputo.
"""

from __future__ import annotations

import json
import logging
import os
import time

import boto3
from botocore.config import Config

from common.control import ControlStore
from common.datasets import (
    ALLOWED_FILES, DATASETS, DATASETS_BY_NAME, all_in_order, dependency_closure, required_files,
)
from common.gold_models import load_models
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

UPLOAD_URL_TTL_SECONDS = 300
MAX_ROWS = 100
QUERY_TIMEOUT_SECONDS = 22  # API Gateway corta a los 29 s


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


# --------------------------------------------------------------- progreso


def _read_progress_docs() -> dict[str, dict]:
    bucket = get_settings().athena_results_bucket
    docs = {}
    for name in [d.name for d in DATASETS] + ["gold"]:
        try:
            docs[name] = json.loads(_s3.get_object(Bucket=bucket, Key=f"{PROGRESS_PREFIX}/{name}.json")["Body"].read())
        except _s3.exceptions.NoSuchKey:
            continue
        except Exception:  # noqa: BLE001 - el progreso es opcional
            logger.warning("No se pudo leer el progreso de %s", name, exc_info=True)
    return docs


def _reconcile_dataset_run(doc: dict, outcomes: dict) -> dict:
    """Si la ejecución terminó pero alguna etapa quedó 'running' (p. ej. timeout), la marca como fallida."""
    stages = doc["stages"]
    unfinished = any(s["status"] in ("running", "pending") for s in stages.values())
    run_status = "RUNNING"
    if any(s["status"] == "failed" for s in stages.values()):
        run_status = "FAILED"  # una etapa ya informó su fallo: no hace falta consultar Step Functions
    elif unfinished:
        arn = doc["executionId"]
        if arn not in outcomes:
            try:
                outcomes[arn] = _execution_outcome(arn)
            except Exception:  # noqa: BLE001
                outcomes[arn] = ("UNKNOWN", None)
        run_status, cause = outcomes[arn]
        if run_status != "RUNNING":
            for s in stages.values():
                if s["status"] == "running":
                    s.update(status="failed", error=cause or run_status)
    else:
        run_status = "FAILED" if any(s["status"] == "failed" for s in stages.values()) else "SUCCEEDED"
    return {"executionId": doc.get("executionId"), "runStatus": run_status, "stages": stages,
            "queued": run_status == "RUNNING" and all(s["status"] == "pending" for s in stages.values())}


def get_state(event):
    settings = get_settings()
    state = ControlStore(settings, _s3).load()
    docs = _read_progress_docs()
    outcomes: dict = {}

    datasets = []
    for d in DATASETS:
        ctl = state.controls.get(d.name) or {}
        doc = docs.get(d.name)
        run = _reconcile_dataset_run(doc, outcomes) if doc else None
        if run and run["runStatus"] not in ("RUNNING",) and all(
                s["status"] == "pending" for s in run["stages"].values()):
            run = None  # estuvo en cola y la ejecución se cortó: no hay nada que mostrar
        datasets.append({
            "name": d.name, "description": d.description, "engine": d.silver_engine,
            "dependsOn": list(d.depends_on),
            "files": [{"name": f, "uploaded": f in state.landing, "size": (state.landing.get(f) or {}).get("size")}
                      for f in d.files],
            "status": state.statuses[d.name],
            "rows": {"bronze": (ctl.get("bronze") or {}).get("rows"), "silver": (ctl.get("silver") or {}).get("rows")},
            "run": run,
        })

    gold_doc = docs.get("gold")
    gold_run = {t["name"]: t for t in (gold_doc or {}).get("tables", [])}
    gold_alive = None
    if gold_doc and any(t["status"] in ("pending", "running") for t in gold_run.values()):
        arn = gold_doc["executionId"]
        try:
            outcomes[arn] = outcomes.get(arn) or _execution_outcome(arn)
        except Exception:  # noqa: BLE001
            outcomes[arn] = ("UNKNOWN", None)
        gold_alive = outcomes[arn][0] == "RUNNING"
        if not gold_alive:
            for t in gold_run.values():
                if t["status"] == "running":
                    t.update(status="failed", error=outcomes[arn][1] or outcomes[arn][0])
    gold = [{"name": m.name, "silverDeps": list(m.silver_deps), "goldDeps": list(m.gold_deps),
             "status": state.gold_statuses[m.name],
             "run": ({**gold_run[m.name], "active": gold_alive} if m.name in gold_run and
                     (gold_alive or gold_run[m.name]["status"] != "pending") else None)}
            for m in load_models()]

    running = bool(_running(os.environ["DATASET_STATE_MACHINE_ARN"]) or _running(os.environ["GOLD_STATE_MACHINE_ARN"]))
    return 200, {"datasets": datasets, "gold": gold, "running": running,
                 "ready": all(f in state.landing for f in ALLOWED_FILES)}


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


def start_pipeline(event):
    body = _json_body(event)
    kind = body.get("kind", "datasets")
    ds_arn, gold_arn = os.environ["DATASET_STATE_MACHINE_ARN"], os.environ["GOLD_STATE_MACHINE_ARN"]
    busy_datasets = {i["dataset"] for r in _running(ds_arn) for i in r["input"].get("datasets", [])}
    gold_busy = bool(_running(gold_arn))

    if kind == "gold":
        models = body.get("models") or []
        known = {m.name for m in load_models()}
        if any(m not in known for m in models):
            raise HttpError(400, "Modelo Gold desconocido.")
        if busy_datasets or gold_busy:
            raise HttpError(409, "Hay pipelines en ejecución. Gold se construye cuando terminan.")
        result = _sfn.start_execution(stateMachineArn=gold_arn, input=json.dumps({"models": models}))
        return 202, {"executionArn": result["executionArn"], "models": models or sorted(known)}

    names = plan_dataset_run(body.get("dataset", ""), body.get("mode", "single"))
    if gold_busy:
        raise HttpError(409, "Se está construyendo Gold. Espera a que termine.")
    clash = sorted(set(names) & busy_datasets)
    if clash:
        raise HttpError(409, f"Ya se está procesando: {', '.join(clash)}.")

    # El sistema EXIGE que estén todos los archivos de lo que va a procesar.
    landing = ControlStore(get_settings(), _s3).landing_objects()
    missing = [f for f in required_files(names) if f not in landing]
    if missing:
        raise HttpError(400, "Faltan archivos en landing para procesar: " + ", ".join(missing),
                        {"missingFiles": missing, "datasets": names})

    payload = {"datasets": [{"dataset": n, "engine": DATASETS_BY_NAME[n].silver_engine} for n in names]}
    result = _sfn.start_execution(stateMachineArn=ds_arn, input=json.dumps(payload))
    return 202, {"executionArn": result["executionArn"], "datasets": names}


def reset_lake(event):
    include_landing = bool(_json_body(event).get("includeLanding", False))
    if _running(os.environ["DATASET_STATE_MACHINE_ARN"]) or _running(os.environ["GOLD_STATE_MACHINE_ARN"]):
        raise HttpError(409, "Hay pipelines en ejecución. Espera a que terminen para reiniciar.")
    result = _lambda.invoke(FunctionName=os.environ["RESET_FUNCTION_NAME"],
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
    "POST /upload-url": create_upload_url,
    "POST /pipeline/start": start_pipeline,
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
