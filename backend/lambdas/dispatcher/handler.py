"""DESPACHADOR EVENT-DRIVEN - una Lambda que reacciona a eventos y decide el siguiente paso.

    S3 landing ──PUT──► SQS events ──► [esta Lambda] ──► ejecuta Bronze / Silver / Gold
                            ▲   ▲                │          y publica el siguiente paso
     EventBridge (Glue) ────┘   │                │ condición no cumplida
                                └── 20 s ── SQS retry-dlq ◄┘
                                                 │ error o 15 intentos
                                                 ▼
                                         SQS dead-letter (DLQ final)

Reglas (ver common/events.py, todas testeadas):
* Llega un CSV  -> Bronze del dataset.
    - si el archivo YA NO está en landing -> ERROR (condición principal) -> DLQ final.
    - si faltan otros CSV del dataset (ej. ventas 2016) -> esperar 20 s y reintentar.
* Termina Bronze -> Silver del dataset.
    - si una tabla padre no está al día -> esperar 20 s y reintentar.
    - tablas grandes: arranca el job de Glue y termina; el FIN del job llega como
      evento de EventBridge a la misma cola.
* Termina Silver -> Silver de las tablas hijas listas + Gold de los modelos que la leen.
* Termina un modelo Gold -> modelos Gold que dependen de él.

Buenas prácticas aplicadas:
* Idempotencia: un evento repetido no reprocesa (ETag consumido / tabla al día).
* Locks con escritura condicional de S3: dos eventos de la misma tabla no corren a la vez.
* Reporte parcial de lotes (``batchItemFailures``): solo se reintenta el mensaje que falló.
* DLQ final para errores y reintentos agotados (con el motivo en el mensaje).
* Logs estructurados (una línea JSON por decisión) + feed de eventos para la web.
"""

from __future__ import annotations

import json
import logging
import os
import time

import boto3

from common.control import ControlStore, STATUS_LABELS, silver_token
from common.datasets import DATASETS_BY_NAME
from common.events import (
    MAX_ATTEMPTS, RETRY_DELAY_SECONDS, S3Lock, append_feed, bronze_precheck, dataset_for_key, gold_precheck,
    new_trace, next_after_gold, next_after_silver, parse_messages, silver_precheck, step_message,
)
from common.control import check_dependencies
from common.gold_models import load_models
from common.mode import get_mode
from common.progress import DatasetProgress, GoldProgress
from common.settings import get_settings
from lambdas.bronze.handler import run_bronze
from lambdas.gold.handler import build_model
from lambdas.silver_dimensions.handler import run_silver_pandas

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sqs = boto3.client("sqs")
s3 = boto3.client("s3")
glue = boto3.client("glue")

EVENTS_QUEUE_URL = os.environ.get("EVENTS_QUEUE_URL", "")
RETRY_QUEUE_URL = os.environ.get("RETRY_QUEUE_URL", "")
DLQ_URL = os.environ.get("DLQ_URL", "")
GLUE_JOB_NAME = os.environ.get("GLUE_JOB_NAME", "")
MODELS = {m.name: m for m in load_models()}


class Dispatcher:
    def __init__(self):
        self.settings = get_settings()
        self.store = ControlStore(self.settings)
        self.bucket = self.settings.athena_results_bucket

    # ------------------------------------------------------------ utilidades
    def feed(self, level: str, kind: str, target: str, text: str, msg: dict | None = None, **extra) -> None:
        entry = {"ts": time.time(), "level": level, "kind": kind, "target": target, "text": text,
                 "trace": (msg or {}).get("trace"), "attempt": (msg or {}).get("attempt", 0), **extra}
        logger.info(json.dumps({"decision": entry}, ensure_ascii=False))  # log estructurado
        try:
            append_feed(s3, self.bucket, entry)
        except Exception:  # noqa: BLE001 - el feed es informativo
            logger.warning("No se pudo escribir el feed", exc_info=True)

    def publish(self, msg: dict) -> None:
        sqs.send_message(QueueUrl=EVENTS_QUEUE_URL, MessageBody=json.dumps(msg))

    def to_dlq(self, msg: dict, reason: str) -> None:
        sqs.send_message(QueueUrl=DLQ_URL, MessageBody=json.dumps({**msg, "deadLetterReason": reason, "deadLetterAt": time.time()}))

    def wait(self, msg: dict, kind: str, target: str, reason: str, on_wait=None, on_exhausted=None) -> None:
        """Condición no cumplida: el mensaje va a la DLQ de reintento (espera 20 s) o, si se agotó, a la DLQ final."""
        attempt = msg.get("attempt", 0) + 1
        if attempt > MAX_ATTEMPTS:
            text = f"{reason}. Se agotaron {MAX_ATTEMPTS} reintentos ({MAX_ATTEMPTS * RETRY_DELAY_SECONDS // 60} min): mensaje enviado a la DLQ final"
            if on_exhausted:
                on_exhausted(text)
            self.to_dlq(msg, text)
            self.feed("error", kind, target, text, msg)
            return
        sqs.send_message(QueueUrl=RETRY_QUEUE_URL, MessageBody=json.dumps({**msg, "attempt": attempt}))
        if on_wait:
            on_wait(attempt)
        self.feed("wait", kind, target, f"{reason}. Reintento {attempt}/{MAX_ATTEMPTS} en {RETRY_DELAY_SECONDS} s", {**msg, "attempt": attempt})

    def lock(self, name: str, owner: str) -> S3Lock:
        return S3Lock(s3, self.bucket, name, owner)

    # --------------------------------------------------------------- entrada
    def handle(self, msg: dict) -> None:
        kind = msg["type"]
        if kind == "test":
            return logger.info("Evento de prueba de S3 (se ignora)")
        if kind == "glue":
            return self.on_glue(msg)
        if get_mode() != "event":
            target = msg.get("key") or msg.get("dataset") or msg.get("model") or "?"
            return self.feed("info", kind, target, "Modo programado activo: el evento se ignora; el archivo espera la próxima ejecución programada", msg)
        if kind == "s3":
            return self.on_file(msg)
        step = msg["step"]
        return {"bronze": self.on_bronze, "silver": self.on_silver, "gold": self.on_gold}[step](msg)

    # ---------------------------------------------------------------- bronze
    def on_file(self, msg: dict) -> None:
        filename, ds = dataset_for_key(msg["key"])
        if ds is None:
            return self.feed("info", "s3", msg["key"], "Archivo que no pertenece a ningún dataset: se ignora")
        trace = new_trace("ds", ds.name)
        step = step_message("bronze", ds.name, trace, origin="s3:ObjectCreated", file=filename, etag=msg["etag"])
        self.feed("info", "s3", filename, f"Llegó a landing → pipeline de {ds.name}", step)
        self.on_bronze(step)

    def on_bronze(self, msg: dict) -> None:
        ds = DATASETS_BY_NAME[msg["dataset"]]
        prog = DatasetProgress.load(self.bucket, ds.name, msg["trace"], ds.silver_engine)
        landing = self.store.landing_objects()
        consumed = ((self.store.read(ds.name) or {}).get("bronze") or {}).get("files") or {}
        decision, detail = bronze_precheck(ds, msg["file"], msg["etag"], landing, consumed)

        if decision == "skip":
            return self.feed("info", "bronze", ds.name, f"{msg['file']}: {detail}", msg)
        if decision == "error":  # condición principal: sin archivo no hay nada que esperar
            text = f"ERROR: {detail}. No se reintenta: el mensaje va a la DLQ final"
            prog.set("bronze", "failed", error=text)
            self.to_dlq(msg, text)
            return self.feed("error", "bronze", ds.name, text, msg)
        if decision == "waiting":
            missing = list(detail)
            return self.wait(
                msg, "bronze", ds.name, f"Faltan archivos del dataset: {', '.join(missing)}",
                on_wait=lambda a: prog.wait("bronze", a, MAX_ATTEMPTS, "Esperando el resto de los archivos del dataset",
                                            [{"dependency": f, "status": "no_file", "reason": "todavía no llegó a landing"} for f in missing]),
                on_exhausted=lambda t: prog.set("bronze", "failed", error=t))

        lock = self.lock(f"dataset-{ds.name}", msg["trace"])
        if not lock.acquire(time.time()):
            return self.wait(msg, "bronze", ds.name, "Otra ejecución está procesando esta tabla")
        try:
            result = run_bronze(self.settings, ds, prog, self.store, when_missing="fail")
        finally:
            lock.release()
        self.feed("ok", "bronze", ds.name, f"Bronze listo: {result['rows']:,} filas; {len(result['archived'])} archivo(s) movidos a archive/", msg)
        self.publish(step_message("silver", ds.name, msg["trace"], origin="bronze"))

    # ---------------------------------------------------------------- silver
    def on_silver(self, msg: dict) -> None:
        name = msg["dataset"]
        ds = DATASETS_BY_NAME[name]
        state = self.store.load()
        decision, detail = silver_precheck(name, state.statuses)
        prog = DatasetProgress.load(self.bucket, name, msg["trace"], ds.silver_engine)
        if decision == "skip":
            if msg.get("origin") == "bronze":  # mismo flujo que acaba de cargar Bronze: cerrar sus etapas
                prog.doc["stages"]["dependencies"] = {"status": "succeeded", "note": str(detail)}
                prog.set("silver", "succeeded", skipped=True, note=f"Sin cambios: {detail}",
                         rows=((state.controls.get(name) or {}).get("silver") or {}).get("rows"))
            return self.feed("info", "silver", name, str(detail), msg)

        if prog.doc["stages"]["bronze"]["status"] == "pending":  # flujo que nace en Silver (tabla hija)
            prog.doc["stages"]["bronze"] = {"status": "succeeded", "note": "Bronze cargado antes",
                                            "rows": ((state.controls.get(name) or {}).get("bronze") or {}).get("rows")}
        if decision == "waiting":
            problems = list(detail)
            return self.wait(
                msg, "silver", name, "Dependencias no al día: " + ", ".join(f"{p['dependency']} ({p['reason']})" for p in problems),
                on_wait=lambda a: prog.wait("dependencies", a, MAX_ATTEMPTS, "Esperando que las tablas padre estén al día", problems),
                on_exhausted=lambda t: prog.set("dependencies", "failed", error=t, detail=problems))

        lock = self.lock(f"dataset-{name}", msg["trace"])
        if not lock.acquire(time.time()):
            return self.wait(msg, "silver", name, "Otra ejecución está procesando esta tabla")
        # Doble verificación con el lock tomado: otro mensaje pudo dejarla al día mientras esperábamos.
        state = self.store.load()
        if silver_precheck(name, state.statuses)[0] != "ready":
            lock.release()
            return self.feed("info", "silver", name, "Ya la procesó otro evento mientras esperaba el lock (idempotencia)", msg)
        prog.set("dependencies", "succeeded", detail=[{"dependency": d, "status": "ok", "reason": STATUS_LABELS["ok"]} for d in ds.depends_on])
        built_from = {d: silver_token(state.controls[d]) for d in ds.depends_on}

        if ds.silver_engine == "glue":
            # Spark tarda minutos: se lanza el job y la Lambda termina. El final llega por EventBridge.
            run = glue.start_job_run(JobName=GLUE_JOB_NAME, Arguments={
                "--dataset": name, "--execution_id": msg["trace"], "--built_from": json.dumps(built_from)})
            prog.set("silver", "running", startedAt=time.time(), glueRunId=run["JobRunId"],
                     note="Job de Glue en curso; su fin llega como evento de EventBridge")
            return self.feed("info", "silver", name, f"Job de Glue (Spark) iniciado: {run['JobRunId'][:18]}…", msg)
        try:
            run_silver_pandas(self.settings, name, prog)
            self.store.record_silver(name, built_from, prog.rows("silver"))
        finally:
            lock.release()
        self.feed("ok", "silver", name, f"Silver listo con pandas: {(prog.rows('silver') or 0):,} filas", msg)
        self.after_silver(name, msg)

    def on_glue(self, msg: dict) -> None:
        if msg["jobName"] != GLUE_JOB_NAME:
            return
        run = glue.get_job_run(JobName=msg["jobName"], RunId=msg["runId"])["JobRun"]
        args = run.get("Arguments") or {}
        trace = args.get("--execution_id", "")
        if not trace.startswith("evt:"):
            return logger.info("Job de Glue del modo programado: lo gestiona Step Functions")
        name = args["--dataset"]
        prog = DatasetProgress.load(self.bucket, name, trace, "glue")
        lock = self.lock(f"dataset-{name}", trace)
        ctx = {"trace": trace}
        if msg["state"] == "SUCCEEDED":
            self.store.record_silver(name, json.loads(args.get("--built_from") or "{}"), prog.rows("silver"))
            lock.release()
            self.feed("ok", "glue", name, f"Glue terminó: Silver listo ({(prog.rows('silver') or 0):,} filas, {run.get('ExecutionTime', 0)} s)", ctx)
            return self.after_silver(name, ctx)
        error = msg.get("message") or run.get("ErrorMessage") or msg["state"]
        prog.set("silver", "failed", error=f"Glue {msg['state']}: {error}")
        lock.release()
        self.feed("error", "glue", name, f"Glue {msg['state']}: {error}", ctx)

    def after_silver(self, name: str, msg: dict) -> None:
        """Fan-out: solo se publica lo que ya tiene todas sus tablas Silver al día (evita esperas inútiles)."""
        state = self.store.load()
        children, models = next_after_silver(name, state.statuses)
        children = [c for c in children if not check_dependencies(c, state.statuses)]
        models = [m for m in models if all(state.statuses[s] == "ok" for s in MODELS[m].silver_deps)]
        for c in children:
            self.publish(step_message("silver", c, new_trace("ds", c), origin=f"silver:{name}"))
        for m in models:
            self.publish(step_message("gold", m, new_trace("gold", m), origin=f"silver:{name}"))
        if children or models:
            self.feed("info", "silver", name, "Siguiente: " + ", ".join([f"silver.{c}" for c in children] + [f"gold.{m}" for m in models]), msg)

    # ------------------------------------------------------------------ gold
    def on_gold(self, msg: dict) -> None:
        model = MODELS[msg["model"]]
        state = self.store.load()
        decision, detail = gold_precheck(model, state.statuses, state.gold_statuses)
        if decision == "skip":
            return self.feed("info", "gold", model.name, str(detail), msg)
        prog = GoldProgress(self.bucket, msg["trace"], [model.name])
        if decision == "waiting":
            problems = list(detail)
            return self.wait(
                msg, "gold", model.name, "Dependencias no al día: " + ", ".join(p["dependency"] for p in problems),
                on_wait=lambda a: prog.set(model.name, "waiting", attempt=a, maxAttempts=MAX_ATTEMPTS, detail=problems,
                                           reason="Esperando que sus tablas estén al día"),
                on_exhausted=lambda t: prog.block(model.name, t, problems))

        lock = self.lock(f"gold-{model.name}", msg["trace"])
        if not lock.acquire(time.time()):
            return self.wait(msg, "gold", model.name, "Otra ejecución está construyendo este modelo")
        state = self.store.load()  # doble verificación con el lock tomado
        if gold_precheck(model, state.statuses, state.gold_statuses)[0] != "ready":
            lock.release()
            return self.feed("info", "gold", model.name, "Ya lo construyó otro evento mientras esperaba el lock (idempotencia)", msg)
        try:
            with prog.table(model.name):
                build_model(self.settings, self.store, model, state)
        finally:
            lock.release()
        # Solo se publican los modelos hijos que ya tienen TODOS sus padres al día: el último padre en terminar los dispara.
        after = self.store.load()
        nxt = [m for m in next_after_gold(model.name) if gold_precheck(MODELS[m], after.statuses, after.gold_statuses)[0] == "ready"]
        for m in nxt:
            self.publish(step_message("gold", m, new_trace("gold", m), origin=f"gold:{model.name}"))
        self.feed("ok", "gold", model.name, "Modelo construido (CTAS)" + (f" → siguiente: {', '.join(nxt)}" if nxt else ""), msg)


def lambda_handler(event, context):
    """Procesa un lote de SQS. Devuelve los mensajes que fallaron para que SOLO esos se reintenten."""
    dispatcher = Dispatcher()
    failures = []
    for record in event.get("Records", []):
        try:
            for msg in parse_messages(record["body"]):
                dispatcher.handle(msg)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Falló el mensaje %s", record.get("messageId"))
            dispatcher.feed("error", "dispatcher", record.get("messageId", "?"), f"Error inesperado: {exc}. SQS lo reintentará y, tras 3 fallos, irá a la DLQ final")
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
