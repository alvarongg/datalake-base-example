"""OBSERVABILIDAD - logs y ejecuciones de cada parte del pipeline.

Rutas (JWT de Cognito):

  GET /logs?source=<id>&minutes=60&level=all|error|warn&limit=300&q=texto
        Eventos de CloudWatch Logs de UN componente (Lambda, Step Functions o Glue),
        clasificados como ERROR / WARN / INFO. Los más recientes primero.
  GET /logs?summary=1&minutes=60
        Cantidad de errores recientes de CADA componente (para el semáforo de la web).
  GET /runs
        Últimas ejecuciones de Step Functions y de Glue, con la causa si fallaron.

Solo lee: el rol de esta función no puede escribir ni modificar nada.
Los grupos de logs permitidos vienen de la configuración (LOG_SOURCES), nunca del cliente.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

logs = boto3.client("logs")
sfn = boto3.client("stepfunctions")
glue = boto3.client("glue")

MAX_SCANNED_EVENTS = 5000
_ERR = re.compile(r"(\berror\b|\bexception\b|\btraceback\b|\bfatal\b|\bcritical\b|task timed out|errormessage|errortype|failed\"|executionfailed|taskfailed|timedout|aborted)", re.I)
_WARN = re.compile(r"(\bwarn(ing)?\b)", re.I)
_PLATFORM = re.compile(r"^(START|END|REPORT|INIT_START|EXTENSION)\b")


class BadRequest(Exception):
    pass


def classify(message: str) -> str:
    """ERROR | WARN | INFO según el texto de la línea de log."""
    if _ERR.search(message):
        return "ERROR"
    if _WARN.search(message):
        return "WARN"
    return "INFO"


def clamp(value, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _json(status: int, body) -> dict:
    return {"statusCode": status, "headers": {"Content-Type": "application/json"}, "body": json.dumps(body, default=str)}


# ----------------------------------------------------------------------- logs


def glue_run_ids(job: str, since: datetime) -> list[str]:
    runs = glue.get_job_runs(JobName=job, MaxResults=20)["JobRuns"]
    return [r["Id"] for r in runs if (r.get("CompletedOn") or r["StartedOn"]) >= since - timedelta(minutes=5)]


def fetch_events(groups: list[str], start_ms: int, end_ms: int, stream_prefixes: list[str] | None = None) -> list[dict]:
    """Eventos de varios grupos (y prefijos de stream) en la ventana. Tolera grupos aún inexistentes."""
    out: list[dict] = []
    for group in groups:
        for prefix in (stream_prefixes or [None]):
            kwargs = {"logGroupName": group, "startTime": start_ms, "endTime": end_ms}
            if prefix:
                kwargs["logStreamNamePrefix"] = prefix
            try:
                for page in logs.get_paginator("filter_log_events").paginate(**kwargs):
                    for e in page["events"]:
                        out.append({"ts": e["timestamp"], "stream": e["logStreamName"], "group": group,
                                    "message": e["message"].rstrip()})
                    if len(out) >= MAX_SCANNED_EVENTS:
                        return out
            except logs.exceptions.ResourceNotFoundException:
                continue  # el grupo se crea con la primera ejecución
    return out


def get_logs(params: dict, sources: dict, glue_job: str) -> dict:
    source = params.get("source", "")
    if source not in sources:
        raise BadRequest(f"source debe ser uno de: {', '.join(sources)}")
    cfg = sources[source]
    minutes = clamp(params.get("minutes"), 5, 1440, 60)
    limit = clamp(params.get("limit"), 10, 500, 300)
    level = params.get("level", "all")
    needle = (params.get("q") or "").lower()
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=minutes)
    prefixes = glue_run_ids(glue_job, start) if cfg["kind"] == "glue" else None
    if cfg["kind"] == "glue" and not prefixes:
        events = []
    else:
        events = fetch_events(cfg["groups"], int(start.timestamp() * 1000), int(end.timestamp() * 1000), prefixes)

    counts = {"ERROR": 0, "WARN": 0, "INFO": 0}
    rows = []
    for e in events:
        lvl = classify(e["message"])
        counts[lvl] += 1
        if level == "error" and lvl != "ERROR":
            continue
        if level == "warn" and lvl == "INFO":
            continue
        if needle and needle not in e["message"].lower():
            continue
        rows.append({**e, "level": lvl, "platform": bool(_PLATFORM.match(e["message"]))})
    rows.sort(key=lambda r: r["ts"], reverse=True)
    return {"source": source, "label": cfg["label"], "groups": cfg["groups"], "minutes": minutes, "counts": counts,
            "total": len(rows), "truncated": len(rows) > limit, "events": rows[:limit]}


def get_summary(params: dict, sources: dict, glue_job: str) -> dict:
    minutes = clamp(params.get("minutes"), 5, 1440, 60)

    def one(item):
        sid, cfg = item
        try:
            res = get_logs({"source": sid, "minutes": minutes, "limit": 10}, sources, glue_job)
            return sid, {"label": cfg["label"], "kind": cfg["kind"], "stage": cfg.get("stage"), **res["counts"]}
        except Exception as exc:  # noqa: BLE001
            return sid, {"label": cfg["label"], "kind": cfg["kind"], "stage": cfg.get("stage"), "ERROR": 0, "WARN": 0, "INFO": 0,
                         "unavailable": str(exc)[:120]}

    with ThreadPoolExecutor(8) as pool:
        return {"minutes": minutes, "sources": dict(pool.map(one, sources.items()))}


# ----------------------------------------------------------------------- runs


def failure_cause(execution_arn: str) -> str | None:
    for page in sfn.get_paginator("get_execution_history").paginate(executionArn=execution_arn, reverseOrder=True):
        for ev in page["events"]:
            d = next((v for k, v in ev.items() if k.endswith("FailedEventDetails")), None)
            if d:
                return d.get("cause") or d.get("error")
    return None


def get_runs(machines: dict[str, str], glue_job: str) -> dict:
    def machine_runs(item):
        label, arn = item
        rows = []
        for e in sfn.list_executions(stateMachineArn=arn, maxResults=20)["executions"]:
            rows.append({"kind": label, "id": e["name"], "arn": e["executionArn"], "status": e["status"],
                         "startedAt": e["startDate"], "stoppedAt": e.get("stopDate")})

        def enrich(r):
            d = sfn.describe_execution(executionArn=r["arn"])
            try:
                inp = json.loads(d.get("input") or "{}")
            except json.JSONDecodeError:
                inp = {}
            r["input"] = [x["dataset"] for x in inp.get("datasets", [])] or inp.get("models") or []
            r["error"] = failure_cause(r["arn"]) if r["status"] in ("FAILED", "TIMED_OUT", "ABORTED") else None
            return r
        with ThreadPoolExecutor(6) as pool:
            return list(pool.map(enrich, rows))

    runs: list[dict] = []
    for chunk in map(machine_runs, machines.items()):
        runs += chunk
    for r in glue.get_job_runs(JobName=glue_job, MaxResults=15)["JobRuns"]:
        runs.append({"kind": "glue", "id": r["Id"], "arn": r["Id"], "status": r["JobRunState"], "startedAt": r["StartedOn"],
                     "stoppedAt": r.get("CompletedOn"), "input": [(r.get("Arguments") or {}).get("--dataset", "")],
                     "error": r.get("ErrorMessage")})
    runs.sort(key=lambda r: r["startedAt"], reverse=True)
    return {"runs": runs[:40], "generatedAt": datetime.now(timezone.utc).isoformat()}


# ---------------------------------------------------------------------- entrada


def lambda_handler(event, context):
    sources = json.loads(os.environ["LOG_SOURCES"])
    machines = json.loads(os.environ["STATE_MACHINES"])
    glue_job = os.environ["GLUE_JOB"]
    params = event.get("queryStringParameters") or {}
    try:
        if event.get("routeKey") == "GET /runs":
            return _json(200, get_runs(machines, glue_job))
        if params.get("summary"):
            return _json(200, get_summary(params, sources, glue_job))
        return _json(200, get_logs(params, sources, glue_job))
    except BadRequest as exc:
        return _json(400, {"message": str(exc)})
    except Exception:  # noqa: BLE001 - sin detalles internos al cliente
        logger.exception("Error en observabilidad")
        return _json(500, {"message": "Error interno."})
