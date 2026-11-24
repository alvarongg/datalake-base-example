"""VERIFICAR DEPENDENCIAS - la compuerta entre Bronze y Silver.

Un pipeline real no transforma una tabla "hija" si las tablas "padre" de las
que depende no están al día. Aquí se aplica esa regla:

* ``products`` necesita ``product_subcategories`` al día, que a su vez necesita
  ``product_categories``.
* ``sales`` necesita products, customers, territories y calendar.

"Al día" significa: su Silver existe, se construyó con el archivo actual de
landing y con la última versión de SUS propias dependencias (ver common/control.py).

Si alguna dependencia no cumple, esta función lanza ``DependencyError`` y la
ejecución de Step Functions termina en FAILED con el motivo exacto. Si todas
cumplen, devuelve ``built_from``: los tokens de las dependencias con los que se
va a construir Silver (quedan registrados como lineage).
"""

from __future__ import annotations

import logging

from common.control import ControlStore, DependencyError, check_dependencies, silver_token, STATUS_LABELS
from common.datasets import DATASETS_BY_NAME
from common.progress import DatasetProgress
from common.settings import get_settings

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    settings = get_settings()
    ds = DATASETS_BY_NAME[event["dataset"]]
    progress = DatasetProgress.load(settings.athena_results_bucket, ds.name,
                                    event.get("executionId"), ds.silver_engine)

    with progress.stage("dependencies") as info:
        state = ControlStore(settings).load()
        # Detalle de TODAS las dependencias (también las que están bien) para mostrarlo en la web.
        info["detail"] = [{"dependency": d, "status": state.statuses[d], "reason": STATUS_LABELS[state.statuses[d]]}
                          for d in ds.depends_on]
        problems = check_dependencies(ds.name, state.statuses)
        if problems:
            raise DependencyError(ds.name, problems)
        built_from = {d: silver_token(state.controls[d]) for d in ds.depends_on}

    logger.info("dependencias de %s OK: %s", ds.name, list(ds.depends_on))
    return {"dataset": ds.name, "built_from": built_from}
