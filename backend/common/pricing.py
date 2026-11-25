"""Precios de lista de AWS (us-east-1) y funciones de costo estimado.

IMPORTANTE: son ESTIMACIONES con precios de lista, sin capa gratuita ni
descuentos. La factura real llega en Cost Explorer con hasta 24 h de retraso;
estas funciones permiten ver el costo aproximado casi en tiempo real a partir
de métricas de uso (CloudWatch, historial de Glue/Athena/Step Functions).

Fuente de precios: https://aws.amazon.com/pricing/ (revisar si cambian).
Todas son funciones puras para poder testearlas sin AWS.
"""

from __future__ import annotations

GB = 1024**3
TB = 1024**4

PRICES = {
    "lambda_per_million_requests": 0.20,
    "lambda_per_gb_second": 0.0000166667,        # x86_64
    "athena_per_tb_scanned": 5.00,
    "athena_min_bytes_per_query": 10 * 1024**2,  # Athena factura mínimo 10 MB por consulta
    "glue_per_dpu_hour": 0.44,
    "stepfunctions_per_1000_transitions": 0.025, # flujos Standard
    "apigw_http_per_million_requests": 1.00,
    "cloudfront_per_gb": 0.085,
    "cloudfront_per_10k_https_requests": 0.01,
    "s3_standard_per_gb_month": 0.023,
    "logs_ingest_per_gb": 0.50,
}

HOURS_PER_MONTH = 730


def lambda_cost(invocations: float, duration_ms: float, memory_mb: int) -> float:
    gb_seconds = (duration_ms / 1000.0) * (memory_mb / 1024.0)
    return invocations / 1e6 * PRICES["lambda_per_million_requests"] + gb_seconds * PRICES["lambda_per_gb_second"]


def athena_cost(bytes_scanned: int) -> float:
    billed = max(bytes_scanned, PRICES["athena_min_bytes_per_query"])
    return billed / TB * PRICES["athena_per_tb_scanned"]


def glue_cost(dpu_seconds: float) -> float:
    return dpu_seconds / 3600.0 * PRICES["glue_per_dpu_hour"]


def sfn_cost(transitions: int) -> float:
    return transitions / 1000.0 * PRICES["stepfunctions_per_1000_transitions"]


def apigw_cost(requests: float) -> float:
    return requests / 1e6 * PRICES["apigw_http_per_million_requests"]


def cloudfront_cost(requests: float, bytes_out: float) -> float:
    return (bytes_out / GB * PRICES["cloudfront_per_gb"]
            + requests / 10_000 * PRICES["cloudfront_per_10k_https_requests"])


def logs_cost(bytes_ingested: float) -> float:
    return bytes_ingested / GB * PRICES["logs_ingest_per_gb"]


def s3_monthly_cost(bytes_stored: float) -> float:
    return bytes_stored / GB * PRICES["s3_standard_per_gb_month"]
