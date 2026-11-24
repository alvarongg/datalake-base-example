"""PLAN - primer paso de cada ejecución de datasets.

Deja todos los datasets pedidos "en cola" (etapas pendientes) para que la web
muestre de inmediato qué se va a procesar y en qué orden, antes de que el
primero empiece a trabajar. No transforma datos.
"""

from __future__ import annotations

from common.datasets import DATASETS_BY_NAME
from common.progress import DatasetProgress
from common.settings import get_settings


def lambda_handler(event, context):
    settings = get_settings()
    execution_id = event.get("executionId")
    queued = []
    for item in event["datasets"]:
        name = item["dataset"]
        if name not in DATASETS_BY_NAME:  # nunca confiar en la entrada
            raise ValueError(f"Dataset desconocido: {name}")
        DatasetProgress(settings.athena_results_bucket, name, execution_id,
                        DATASETS_BY_NAME[name].silver_engine).reset()
        queued.append(name)
    return {"queued": queued}
