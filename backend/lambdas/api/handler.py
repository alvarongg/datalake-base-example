"""API de la web (API Gateway HTTP + Cognito JWT) en una sola Lambda.

Rutas (todas exigen un token de Cognito, lo valida API Gateway antes de llegar aquí):

  GET  /files                -> qué CSV esperan y cuáles ya están en landing
  POST /upload-url           -> URL prefirmada para subir UN csv directo a S3
  POST /pipeline/start       -> inicia el Step Functions
  GET  /pipeline/status      -> estado por paso (?executionArn=... o el último)
  POST /reset                -> borra bronze/silver/gold (y landing si se pide)
  POST /query                -> SELECT de solo lectura en Athena

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

from common.datasets import ALLOWED_FILES, DATASETS
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
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _json_body(event) -> dict:
    try:
        return json.loads(event.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise HttpError(400, "El cuerpo debe ser JSON válido.") from exc


# ------------------------------------------------------------------ handlers


def list_files(event):
    s = get_settings()
    present = {}
    paginator = _s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=s.landing_bucket, Prefix=f"{DATASET_PREFIX}/"):
        for obj in page.get("Contents", []):
            present[obj["Key"].split("/", 1)[1]] = obj["Size"]

    datasets = [
        {
            "name": d.name,
            "description": d.description,
            "engine": d.silver_engine,
            "files": [{"name": f, "uploaded": f in present, "size": present.get(f)} for f in d.files],
        }
        for d in DATASETS
    ]
    return 200, {"datasets": datasets, "ready": all(f in present for d in DATASETS for f in d.files)}


def create_upload_url(event):
    filename = _json_body(event).get("filename", "")
    # Lista blanca: solo los 10 nombres esperados (evita escribir claves arbitrarias).
    if filename not in ALLOWED_FILES:
        raise HttpError(400, f"Archivo no permitido: '{filename}'.")
    s = get_settings()
    url = _s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": s.landing_bucket,
            "Key": f"{DATASET_PREFIX}/{filename}",
            "ContentType": "text/csv",
        },
        ExpiresIn=UPLOAD_URL_TTL_SECONDS,
    )
    return 200, {"url": url, "contentType": "text/csv", "expiresIn": UPLOAD_URL_TTL_SECONDS}


def start_pipeline(event):
    arn = os.environ["STATE_MACHINE_ARN"]
    running = _sfn.list_executions(stateMachineArn=arn, statusFilter="RUNNING", maxResults=1)
    if running["executions"]:
        raise HttpError(409, "Ya hay un pipeline en ejecución. Espera a que termine.")
    result = _sfn.start_execution(stateMachineArn=arn)
    return 202, {"executionArn": result["executionArn"]}


def pipeline_status(event):
    arn = os.environ["STATE_MACHINE_ARN"]
    params = event.get("queryStringParameters") or {}
    execution_arn = params.get("executionArn")
    if not execution_arn:  # por defecto: la ejecución más reciente
        latest = _sfn.list_executions(stateMachineArn=arn, maxResults=1)["executions"]
        if not latest:
            return 200, {"status": "NONE", "steps": {}}
        execution_arn = latest[0]["executionArn"]
    elif not execution_arn.startswith(arn.replace(":stateMachine:", ":execution:")):
        raise HttpError(400, "executionArn no pertenece a este pipeline.")

    execution = _sfn.describe_execution(executionArn=execution_arn)
    steps: dict[str, str] = {}
    error = None
    history = _sfn.get_paginator("get_execution_history").paginate(
        executionArn=execution_arn, reverseOrder=False
    )
    for page in history:
        for ev in page["events"]:
            entered = ev.get("stateEnteredEventDetails")
            exited = ev.get("stateExitedEventDetails")
            if entered:
                steps[entered["name"]] = "RUNNING"
            if exited:
                steps[exited["name"]] = "SUCCEEDED"
            if ev["type"].endswith("Failed") and ev["type"] != "ExecutionFailed":
                # marca como fallido el último paso en curso
                for name, st in steps.items():
                    if st == "RUNNING":
                        steps[name] = "FAILED"
                details = next((v for k, v in ev.items() if k.endswith("FailedEventDetails")), {})
                error = details.get("cause") or details.get("error")
            if ev["type"] == "ExecutionFailed":
                details = ev.get("executionFailedEventDetails", {})
                error = error or details.get("cause") or details.get("error")

    body = {
        "executionArn": execution_arn,
        "status": execution["status"],
        "startDate": execution["startDate"],
        "stopDate": execution.get("stopDate"),
        "steps": steps,
        "error": error,
    }
    if execution["status"] == "SUCCEEDED":
        body["output"] = json.loads(execution.get("output") or "{}")
    return 200, body


def reset_lake(event):
    include_landing = bool(_json_body(event).get("includeLanding", False))
    result = _lambda.invoke(
        FunctionName=os.environ["RESET_FUNCTION_NAME"],
        Payload=json.dumps({"include_landing": include_landing}).encode(),
    )
    payload = json.loads(result["Payload"].read())
    if result.get("FunctionError"):
        raise HttpError(500, f"El reset falló: {payload.get('errorMessage', 'error desconocido')}")
    return 200, payload


def run_query(event):
    try:
        sql = validate_select(_json_body(event).get("sql", ""))
    except UnsafeSqlError as exc:
        raise HttpError(400, str(exc)) from exc

    s = get_settings()
    qid = _athena.start_query_execution(
        QueryString=sql,
        WorkGroup=s.athena_workgroup,
        QueryExecutionContext={"Database": s.gold_db},
    )["QueryExecutionId"]

    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    while True:
        status = _athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]["Status"]
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
    return 200, {"columns": columns, "rows": data[:MAX_ROWS], "truncated": len(data) > MAX_ROWS,
                 "queryExecutionId": qid}


ROUTES = {
    "GET /files": list_files,
    "POST /upload-url": create_upload_url,
    "POST /pipeline/start": start_pipeline,
    "GET /pipeline/status": pipeline_status,
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
        return _response(exc.status, {"message": exc.message})
    except Exception:  # noqa: BLE001 - no filtramos detalles internos al cliente
        logger.exception("Error no controlado en %s", route)
        return _response(500, {"message": "Error interno."})
