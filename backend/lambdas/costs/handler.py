"""COSTOS - estimación casi en tiempo real del costo del data lake.

``GET /costs?range=24h|7d|30d`` junta el USO real de cada servicio y lo
convierte en dólares con los precios de lista (common/pricing.py):

  Lambda          CloudWatch: invocaciones y duración x memoria configurada
  AWS Glue        historial de ejecuciones del job: segundos de DPU
  Athena          historial de consultas del workgroup: bytes escaneados
  Step Functions  transiciones de estado (se cuentan en el historial de cada ejecución)
  API Gateway     CloudWatch: cantidad de requests
  CloudFront      CloudWatch: requests y bytes servidos
  S3              tamaño actual de cada bucket (costo mensual prorrateado a la ventana)
  CloudWatch Logs CloudWatch: bytes ingeridos por grupo de logs

Es una ESTIMACIÓN (precios de lista, sin capa gratuita). La factura real llega
a Cost Explorer con hasta 24 h de retraso. Cada servicio se consulta de forma
independiente: si uno falla, los demás igual se muestran.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import boto3

from common import pricing as P

logger = logging.getLogger()
logger.setLevel(logging.INFO)

cw = boto3.client("cloudwatch")
athena = boto3.client("athena")
glue = boto3.client("glue")
sfn = boto3.client("stepfunctions")
s3 = boto3.client("s3")

# rango -> (duración de la ventana, tamaño del bucket temporal en segundos)
RANGES = {"24h": (timedelta(hours=24), 3600), "7d": (timedelta(days=7), 6 * 3600), "30d": (timedelta(days=30), 86400)}
MAX_EXECUTIONS_FOR_TRANSITIONS = 60
MAX_S3_OBJECTS_PER_BUCKET = 50_000

SERVICE_LABELS = {
    "lambda": "AWS Lambda", "glue": "AWS Glue", "athena": "Amazon Athena", "stepfunctions": "AWS Step Functions",
    "s3": "Amazon S3", "apigateway": "Amazon API Gateway", "cloudfront": "Amazon CloudFront",
    "logs": "CloudWatch Logs", "cognito": "Amazon Cognito", "sqs": "Amazon SQS", "eventbridge": "Amazon EventBridge",
}


# ----------------------------------------------------------- utilidades puras


def floor_ts(ts: datetime, period: int) -> datetime:
    return datetime.fromtimestamp(int(ts.timestamp()) // period * period, tz=timezone.utc)


def make_buckets(start: datetime, end: datetime, period: int) -> list[datetime]:
    out, t = [], floor_ts(start, period)
    while t <= end:
        out.append(t)
        t += timedelta(seconds=period)
    return out


def bucket_index(ts: datetime, first: datetime, period: int, n: int) -> int:
    return max(0, min(n - 1, int((ts - first).total_seconds() // period)))


def monthly_projection(total: float, window_hours: float) -> float:
    """Ritmo mensual si el uso de la ventana se mantuviera (solo orientativo)."""
    return total / window_hours * P.HOURS_PER_MONTH if window_hours else 0.0


# ------------------------------------------------------------------ CloudWatch


def metric_series(queries: dict[str, tuple[str, str, list[dict], str]], start, end, period) -> dict[str, dict[datetime, float]]:
    """queries: id -> (namespace, metric, dimensions, stat). Devuelve id -> {timestamp: valor}."""
    out: dict[str, dict[datetime, float]] = {k: {} for k in queries}
    ids = list(queries)
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        data = [{"Id": f"m{n}", "ReturnData": True, "MetricStat": {
            "Metric": {"Namespace": queries[k][0], "MetricName": queries[k][1], "Dimensions": queries[k][2]},
            "Period": period, "Stat": queries[k][3]}} for n, k in enumerate(chunk)]
        token = None
        while True:
            resp = cw.get_metric_data(MetricDataQueries=data, StartTime=start, EndTime=end,
                                      **({"NextToken": token} if token else {}))
            for r in resp["MetricDataResults"]:
                key = chunk[int(r["Id"][1:])]
                for ts, v in zip(r["Timestamps"], r["Values"]):
                    out[key][ts] = out[key].get(ts, 0.0) + v
            token = resp.get("NextToken")
            if not token:
                break
    return out


class Ctx:
    """Ventana de tiempo compartida por todos los servicios."""

    def __init__(self, rng: str):
        span, self.period = RANGES[rng]
        self.end = datetime.now(timezone.utc)
        self.start = self.end - span
        self.buckets = make_buckets(self.start, self.end, self.period)
        self.hours = span.total_seconds() / 3600

    def zeros(self) -> list[float]:
        return [0.0] * len(self.buckets)

    def put(self, series: list[float], ts: datetime, value: float) -> None:
        series[bucket_index(ts, self.buckets[0], self.period, len(self.buckets))] += value

    def from_metric(self, m: dict[datetime, float], fn) -> list[float]:
        s = self.zeros()
        for ts, v in m.items():
            self.put(s, ts, fn(v))
        return s


def service(id_, cost_series, usage, details=None, note=None, error=None):
    return {"id": id_, "label": SERVICE_LABELS[id_], "cost": round(sum(cost_series), 6),
            "usage": usage, "details": details or [], "note": note, "error": error, "_series": cost_series}


# ------------------------------------------------------------------ servicios


def cost_lambda(ctx: Ctx, functions: dict[str, dict]):
    q = {}
    for key, f in functions.items():
        dim = [{"Name": "FunctionName", "Value": f["name"]}]
        q[f"inv:{key}"] = ("AWS/Lambda", "Invocations", dim, "Sum")
        q[f"dur:{key}"] = ("AWS/Lambda", "Duration", dim, "Sum")
    m = metric_series(q, ctx.start, ctx.end, ctx.period)
    series, details, inv_total, dur_total = ctx.zeros(), [], 0.0, 0.0
    for key, f in functions.items():
        inv, dur = m[f"inv:{key}"], m[f"dur:{key}"]
        c = 0.0
        for ts in set(inv) | set(dur):
            v = P.lambda_cost(inv.get(ts, 0), dur.get(ts, 0), f["memory"])
            ctx.put(series, ts, v)
            c += v
        n, d = sum(inv.values()), sum(dur.values())
        inv_total += n
        dur_total += d
        details.append({"label": f["label"], "invocations": int(n), "durationSeconds": round(d / 1000, 1),
                        "memoryMb": f["memory"], "cost": round(c, 6)})
    usage = [{"label": "Invocaciones", "value": int(inv_total), "unit": ""},
             {"label": "Tiempo facturable", "value": round(dur_total / 1000, 1), "unit": "s"}]
    return service("lambda", series, usage, sorted(details, key=lambda d: -d["cost"]))


def cost_glue(ctx: Ctx, job: str):
    series, details, dpu_total = ctx.zeros(), [], 0.0
    for page in glue.get_paginator("get_job_runs").paginate(JobName=job):
        stop = False
        for run in page["JobRuns"]:
            if run["StartedOn"] < ctx.start:
                stop = True
                continue
            dpus = (run.get("NumberOfWorkers") or 2)  # G.1X = 1 DPU por worker
            dpu_seconds = float(run.get("DPUSeconds") or (run.get("ExecutionTime", 0) * dpus))
            c = P.glue_cost(dpu_seconds)
            ctx.put(series, run["StartedOn"], c)
            dpu_total += dpu_seconds
            details.append({"label": (run.get("Arguments") or {}).get("--dataset", run["Id"][:12]), "state": run["JobRunState"],
                            "seconds": run.get("ExecutionTime", 0), "dpuSeconds": round(dpu_seconds), "cost": round(c, 6)})
        if stop:
            break
    usage = [{"label": "Ejecuciones", "value": len(details), "unit": ""},
             {"label": "DPU-horas", "value": round(dpu_total / 3600, 3), "unit": ""}]
    return service("glue", series, usage, details[:20],
                   note="Un job de Spark factura por segundo de DPU: por eso para datasets chicos una Lambda es más barata.")


def cost_athena(ctx: Ctx, workgroup: str):
    series, n_queries, total_bytes, billed = ctx.zeros(), 0, 0, 0
    ids: list[str] = []
    done = False
    for page in athena.get_paginator("list_query_executions").paginate(WorkGroup=workgroup, PaginationConfig={"MaxItems": 500}):
        batch = page["QueryExecutionIds"]
        for i in range(0, len(batch), 50):
            res = athena.batch_get_query_execution(QueryExecutionIds=batch[i:i + 50])["QueryExecutions"]
            for q in res:
                submitted = q["Status"]["SubmissionDateTime"]
                if submitted < ctx.start:
                    done = True
                    continue
                scanned = (q.get("Statistics") or {}).get("DataScannedInBytes", 0)
                n_queries += 1
                total_bytes += scanned
                if scanned > 0 or q.get("StatementType") == "DML":  # DDL sin escaneo no se factura
                    billed += 1
                    ctx.put(series, submitted, P.athena_cost(scanned))
        ids += batch
        if done:
            break
    usage = [{"label": "Consultas", "value": n_queries, "unit": ""},
             {"label": "Datos escaneados", "value": round(total_bytes / 1024**2, 2), "unit": "MB"},
             {"label": "Consultas facturadas", "value": billed, "unit": ""}]
    return service("athena", series, usage,
                   note="Se factura por datos escaneados (mínimo 10 MB por consulta). Particionar y usar Parquet reduce el costo.")


def cost_stepfunctions(ctx: Ctx, machines: dict[str, str]):
    series, details, total_tr = ctx.zeros(), [], 0
    for label, arn in machines.items():
        execs = []
        for page in sfn.get_paginator("list_executions").paginate(stateMachineArn=arn, PaginationConfig={"MaxItems": 300}):
            for e in page["executions"]:
                if e["startDate"] >= ctx.start:
                    execs.append(e)
        execs = execs[:MAX_EXECUTIONS_FOR_TRANSITIONS]

        def transitions(e):
            n = 0
            for pg in sfn.get_paginator("get_execution_history").paginate(executionArn=e["executionArn"], includeExecutionData=False):
                n += sum(1 for ev in pg["events"] if "stateEnteredEventDetails" in ev)
            return e["startDate"], n

        with ThreadPoolExecutor(8) as pool:
            counted = list(pool.map(transitions, execs))
        n_tr = sum(n for _, n in counted)
        for ts, n in counted:
            ctx.put(series, ts, P.sfn_cost(n))
        total_tr += n_tr
        details.append({"label": label, "executions": len(execs), "transitions": n_tr, "cost": round(P.sfn_cost(n_tr), 6)})
    return service("stepfunctions", series, [{"label": "Transiciones de estado", "value": total_tr, "unit": ""}], details)


def cost_s3(ctx: Ctx, buckets: dict[str, str]):
    details, total_bytes = [], 0
    for label, name in buckets.items():
        size = count = 0
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=name, PaginationConfig={"MaxItems": MAX_S3_OBJECTS_PER_BUCKET}):
            for o in page.get("Contents", []):
                size += o["Size"]
                count += 1
        total_bytes += size
        details.append({"label": label, "objects": count, "megabytes": round(size / 1024**2, 2),
                        "monthlyCost": round(P.s3_monthly_cost(size), 6)})
    monthly = P.s3_monthly_cost(total_bytes)
    per_bucket = monthly * (ctx.period / 3600) / P.HOURS_PER_MONTH  # prorrateo uniforme a la ventana
    series = [per_bucket] * len(ctx.buckets)
    return service("s3", series, [{"label": "Almacenado", "value": round(total_bytes / 1024**2, 2), "unit": "MB"},
                                  {"label": "Costo mensual si se mantiene", "value": round(monthly, 4), "unit": "USD"}], details,
                   note="Se prorratea el costo mensual de almacenamiento a la ventana elegida. Las requests de S3 son despreciables aquí.")


def cost_simple(ctx: Ctx, id_: str, queries, fn_cost, usage_fn):
    m = metric_series(queries, ctx.start, ctx.end, ctx.period)
    series = ctx.zeros()
    keys = set().union(*[set(v) for v in m.values()]) if m else set()
    for ts in keys:
        ctx.put(series, ts, fn_cost({k: v.get(ts, 0.0) for k, v in m.items()}))
    totals = {k: sum(v.values()) for k, v in m.items()}
    return service(id_, series, usage_fn(totals))


def collect(rng: str, cfg: dict) -> dict:
    ctx = Ctx(rng)
    tasks = {
        "lambda": lambda: cost_lambda(ctx, cfg["lambdas"]),
        "glue": lambda: cost_glue(ctx, cfg["glueJob"]),
        "athena": lambda: cost_athena(ctx, cfg["workgroup"]),
        "stepfunctions": lambda: cost_stepfunctions(ctx, cfg["machines"]),
        "s3": lambda: cost_s3(ctx, cfg["buckets"]),
        "apigateway": lambda: cost_simple(
            ctx, "apigateway",
            {"count": ("AWS/ApiGateway", "Count", [{"Name": "ApiId", "Value": cfg["apiId"]}], "Sum")},
            lambda m: P.apigw_cost(m["count"]),
            lambda t: [{"label": "Requests", "value": int(t["count"]), "unit": ""}]),
        "cloudfront": lambda: cost_simple(
            ctx, "cloudfront",
            {"req": ("AWS/CloudFront", "Requests", [{"Name": "DistributionId", "Value": cfg["distributionId"]}, {"Name": "Region", "Value": "Global"}], "Sum"),
             "bytes": ("AWS/CloudFront", "BytesDownloaded", [{"Name": "DistributionId", "Value": cfg["distributionId"]}, {"Name": "Region", "Value": "Global"}], "Sum")},
            lambda m: P.cloudfront_cost(m["req"], m["bytes"]),
            lambda t: [{"label": "Requests", "value": int(t["req"]), "unit": ""},
                       {"label": "Datos servidos", "value": round(t["bytes"] / 1024**2, 2), "unit": "MB"}]),
        "sqs": lambda: cost_simple(
            ctx, "sqs",
            {f"{m}:{q}": ("AWS/SQS", m, [{"Name": "QueueName", "Value": q}], "Sum")
             for q in cfg.get("queues", {}).values()
             for m in ("NumberOfMessagesSent", "NumberOfMessagesReceived", "NumberOfMessagesDeleted", "NumberOfEmptyReceives")},
            lambda m: P.sqs_cost(sum(m.values())),
            lambda t: [{"label": "Requests", "value": int(sum(t.values())), "unit": ""},
                       {"label": "Mensajes enviados", "value": int(sum(v for k, v in t.items() if k.startswith("NumberOfMessagesSent"))), "unit": ""}]),
        "logs": lambda: cost_simple(
            ctx, "logs",
            {f"g{i}": ("AWS/Logs", "IncomingBytes", [{"Name": "LogGroupName", "Value": g}], "Sum") for i, g in enumerate(cfg["logGroups"])},
            lambda m: P.logs_cost(sum(m.values())),
            lambda t: [{"label": "Logs ingeridos", "value": round(sum(t.values()) / 1024**2, 3), "unit": "MB"}]),
    }

    def run(item):
        key, fn = item
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - un servicio caído no debe tumbar todo el reporte
            logger.exception("Costos de %s", key)
            return service(key, ctx.zeros(), [], error=str(exc)[:200])

    with ThreadPoolExecutor(8) as pool:
        services = list(pool.map(run, tasks.items()))
    for s in services:
        if s["id"] == "sqs":
            s["note"] = ("La Lambda hace long polling continuo sobre 2 colas: aun sin mensajes genera "
                         "~unos cientos de miles de requests al mes (centavos). Es el costo fijo de event-driven.")
    services.append(service("eventbridge", ctx.zeros(), [{"label": "Reglas", "value": 2, "unit": ""}],
                            note="Los eventos de servicios de AWS (fin de Glue) y las reglas programadas no tienen costo."))
    services.append(service("cognito", ctx.zeros(), [{"label": "Usuarios activos", "value": 0, "unit": ""}],
                            note="Cognito es gratis hasta 50.000 usuarios activos al mes (capa gratuita)."))

    series = [{"t": b.isoformat(), **{s["id"]: round(s["_series"][i], 6) for s in services},
               "total": round(sum(s["_series"][i] for s in services), 6)} for i, b in enumerate(ctx.buckets)]
    for s in services:
        s.pop("_series")
    total = round(sum(s["cost"] for s in services), 6)
    return {"range": rng, "generatedAt": ctx.end.isoformat(), "windowHours": ctx.hours, "periodSeconds": ctx.period,
            "currency": "USD", "total": total, "monthlyProjection": round(monthly_projection(total, ctx.hours), 4),
            "services": sorted(services, key=lambda s: -s["cost"]), "series": series, "prices": P.PRICES}


def lambda_handler(event, context):
    params = event.get("queryStringParameters") or {}
    rng = params.get("range", "24h")
    if rng not in RANGES:
        return {"statusCode": 400, "headers": {"Content-Type": "application/json"},
                "body": json.dumps({"message": f"range debe ser uno de {', '.join(RANGES)}"})}
    cfg = json.loads(os.environ["COST_CONFIG"])
    return {"statusCode": 200, "headers": {"Content-Type": "application/json"}, "body": json.dumps(collect(rng, cfg), default=str)}
