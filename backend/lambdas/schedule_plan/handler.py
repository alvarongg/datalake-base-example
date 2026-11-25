"""PLAN PROGRAMADO - primer paso del flujo programado (EventBridge cada 30 min → Step Functions).

Buena práctica: nunca dos lotes a la vez. Si ya hay otra ejecución programada en
curso (ej. la del horario y una manual), esta termina sin hacer nada.

Una arquitectura programada no reacciona a cada archivo: se despierta cada X
tiempo, mira qué hay pendiente y lo procesa TODO en un solo lote, en orden.

Este paso decide ese lote:
1. Si el modo no es ``scheduled`` (y no es una ejecución manual), no hace nada.
2. Datasets con archivo completo en landing (lo que hay ahí es lo que falta procesar).
3. Más los que ya tienen Bronze pero no Silver al día.
4. Más sus "hijos" (si cambia products, hay que rehacer sales y returns).
5. Todo ordenado por dependencias (padres primero).

Devuelve además si hay modelos Gold sin construir o desactualizados.
"""

from __future__ import annotations

import os

import boto3

from common.control import ControlStore
from common.datasets import DATASETS, DATASETS_BY_NAME, all_in_order
from common.mode import get_mode
from common.settings import get_settings


def plan_datasets(landing_versions: dict[str, str | None], controls: dict[str, dict], statuses: dict[str, str]) -> list[str]:
    """Función pura: qué datasets procesar y en qué orden."""
    # Todo archivo completo que está en landing se procesa (aunque su contenido sea igual al ya cargado):
    # lo que hay en landing es, por definición, lo que falta procesar. Después Bronze lo mueve a archive/.
    changed = {d.name for d in DATASETS if landing_versions.get(d.name)}
    need = changed | {n for n, s in statuses.items() if s in ("bronze", "stale")}
    grew = True
    while grew:  # hijos de lo que se va a rehacer (solo si ya tienen datos)
        grew = False
        for d in DATASETS:
            if d.name not in need and statuses[d.name] not in ("no_file", "pending") and any(p in need for p in d.depends_on):
                need.add(d.name)
                grew = True
    return [n for n in all_in_order() if n in need]


def lambda_handler(event, context):
    manual = bool((event or {}).get("manual"))
    me = (event or {}).get("executionId")
    running = boto3.client("stepfunctions").list_executions(
        stateMachineArn=os.environ["SCHEDULED_STATE_MACHINE_ARN"], statusFilter="RUNNING", maxResults=10)["executions"]
    if any(e["executionArn"] != me for e in running):
        return {"skip": True, "reason": "Ya hay otra ejecución programada en curso: se evita el solapamiento.",
                "datasets": [], "hasDatasets": False, "goldWork": False}
    mode = get_mode(use_cache=False)
    if mode != "scheduled" and not manual:
        return {"skip": True, "reason": "Modo event-driven activo: la ejecución programada no hace nada.",
                "datasets": [], "hasDatasets": False, "goldWork": False}
    state = ControlStore(get_settings()).load()
    names = plan_datasets(state.landing_versions, state.controls, state.statuses)
    return {
        "skip": False, "mode": mode, "manual": manual,
        "datasets": [{"dataset": n, "engine": DATASETS_BY_NAME[n].silver_engine} for n in names],
        "hasDatasets": bool(names),
        "goldWork": bool(names) or any(s != "ok" for s in state.gold_statuses.values()),
    }
