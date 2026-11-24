"""REGISTRAR SILVER - último paso del pipeline de un dataset.

Cuando Silver terminó bien (con pandas o con Glue), anota en el control:
"esta tabla Silver se construyó con ESTA versión de Bronze y con ESTOS tokens
de sus dependencias". Desde ese momento:

* la tabla pasa a estado ``ok`` (puede ser dependencia de otras), y
* si luego se reprocesa una dependencia, esta tabla pasa a ``stale``.

Se hace en un paso aparte para que ambos motores (pandas y Glue) usen
exactamente el mismo código de registro.
"""

from __future__ import annotations

from common.control import ControlStore
from common.datasets import DATASETS_BY_NAME
from common.progress import DatasetProgress
from common.settings import get_settings


def lambda_handler(event, context):
    settings = get_settings()
    name = event["dataset"]
    ds = DATASETS_BY_NAME[name]
    progress = DatasetProgress.load(settings.athena_results_bucket, name, event.get("executionId"), ds.silver_engine)
    ControlStore(settings).record_silver(name, event.get("built_from") or {}, progress.rows("silver"))
    return {"dataset": name, "recorded": True}
