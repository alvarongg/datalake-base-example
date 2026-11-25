"""Cálculo de costos y clasificación de logs (lógica pura, sin AWS)."""

import os
from datetime import datetime, timezone

import pytest

from common import pricing as P

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")  # los clientes boto3 se crean al importar los handlers


def test_lambda_cost_combines_requests_and_gb_seconds():
    # 1M invocaciones de 1 s con 1 GB: $0.20 + 1M GB-s * 0.0000166667
    assert P.lambda_cost(1_000_000, 1_000_000 * 1000, 1024) == pytest.approx(0.20 + 16.6667, rel=1e-4)
    assert P.lambda_cost(0, 0, 1024) == 0


def test_athena_has_a_10mb_minimum_per_query():
    assert P.athena_cost(0) == P.athena_cost(5 * 1024**2) == pytest.approx(10 * 1024**2 / P.TB * 5)
    assert P.athena_cost(P.TB) == pytest.approx(5.0)


def test_glue_is_billed_per_dpu_second():
    assert P.glue_cost(3600) == pytest.approx(0.44)  # 1 DPU durante 1 hora
    assert P.glue_cost(2 * 120) == pytest.approx(240 / 3600 * 0.44)  # 2 DPU durante 2 minutos


def test_other_services():
    assert P.sfn_cost(1000) == pytest.approx(0.025)
    assert P.apigw_cost(1_000_000) == pytest.approx(1.0)
    assert P.cloudfront_cost(10_000, P.GB) == pytest.approx(0.01 + 0.085)
    assert P.logs_cost(P.GB) == pytest.approx(0.5)
    assert P.s3_monthly_cost(P.GB) == pytest.approx(0.023)


def test_buckets_and_indexing():
    from lambdas.costs.handler import bucket_index, make_buckets, monthly_projection

    start = datetime(2026, 1, 1, 10, 30, tzinfo=timezone.utc)
    end = datetime(2026, 1, 1, 13, 10, tzinfo=timezone.utc)
    buckets = make_buckets(start, end, 3600)
    assert [b.hour for b in buckets] == [10, 11, 12, 13]
    assert bucket_index(datetime(2026, 1, 1, 12, 59, tzinfo=timezone.utc), buckets[0], 3600, len(buckets)) == 2
    assert bucket_index(datetime(2030, 1, 1, tzinfo=timezone.utc), buckets[0], 3600, len(buckets)) == 3  # se acota al final
    assert monthly_projection(1.0, 24) == pytest.approx(730 / 24)


@pytest.mark.parametrize("line,level", [
    ("[ERROR] KeyError: 'x'", "ERROR"),
    ("Traceback (most recent call last):", "ERROR"),
    ("Task timed out after 300.00 seconds", "ERROR"),
    ('{"type":"LambdaFunctionFailed","id":"5"}', "ERROR"),
    ("[WARNING] No se pudo escribir el progreso", "WARN"),
    ("[INFO] bronze.sales: 56046 filas", "INFO"),
    ("REPORT RequestId: abc Duration: 12.3 ms", "INFO"),
])
def test_log_levels(line, level):
    from lambdas.observability.handler import classify

    assert classify(line) == level


def test_clamp_and_unknown_source():
    from lambdas.observability.handler import BadRequest, clamp, get_logs

    assert clamp("9999", 5, 1440, 60) == 1440 and clamp("x", 5, 1440, 60) == 60 and clamp(1, 5, 1440, 60) == 5
    with pytest.raises(BadRequest):
        get_logs({"source": "../../etc"}, {"bronze": {"label": "b", "kind": "lambda", "groups": []}}, "job")
