"""Modo de operación del pipeline: ``event`` (event-driven) o ``scheduled`` (programado).

Se guarda en un parámetro de SSM Parameter Store (estándar, sin costo) para que
TODOS los componentes lean la misma fuente de verdad:

* modo ``event``     -> el despachador procesa cada archivo apenas llega; la
                         ejecución programada de Step Functions no hace nada.
* modo ``scheduled`` -> los archivos esperan en landing; la regla de EventBridge
                         dispara Step Functions cada 30 minutos (o a mano) y
                         procesa todo lo nuevo en orden.

Los dos modos nunca corren a la vez: así se evita que dos orquestadores
procesen la misma tabla al mismo tiempo.
"""

from __future__ import annotations

import os
import time

import boto3

MODES = ("event", "scheduled")
DEFAULT_MODE = "event"
_CACHE_SECONDS = 10
_cache: dict = {"value": None, "at": 0.0}


def _param() -> str:
    return os.environ["PIPELINE_MODE_PARAM"]


def get_mode(ssm=None, use_cache: bool = True) -> str:
    """Modo actual. Se cachea 10 s por contenedor para no consultar SSM en cada mensaje."""
    if use_cache and _cache["value"] and time.time() - _cache["at"] < _CACHE_SECONDS:
        return _cache["value"]
    client = ssm or boto3.client("ssm")
    try:
        value = client.get_parameter(Name=_param())["Parameter"]["Value"]
    except client.exceptions.ParameterNotFound:
        value = DEFAULT_MODE
    value = value if value in MODES else DEFAULT_MODE
    _cache.update(value=value, at=time.time())
    return value


def set_mode(mode: str, ssm=None) -> None:
    if mode not in MODES:
        raise ValueError(f"mode debe ser uno de {MODES}")
    (ssm or boto3.client("ssm")).put_parameter(Name=_param(), Value=mode, Type="String", Overwrite=True)
    _cache.update(value=mode, at=time.time())
