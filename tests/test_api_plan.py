"""Planificación de ejecuciones en la API (lógica pura, sin AWS)."""

import pytest


@pytest.fixture(scope="module")
def api(monkeypatch_module=None):
    import os

    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")  # los clientes boto3 se crean al importar
    from lambdas.api import handler

    return handler


def test_single_runs_only_that_dataset(api):
    assert api.plan_dataset_run("products", "single") == ["products"]


def test_with_dependencies_runs_parents_first(api):
    assert api.plan_dataset_run("products", "with_dependencies") == [
        "product_categories", "product_subcategories", "products"]


def test_all_respects_dependency_order(api):
    order = api.plan_dataset_run("all", "single")
    assert order.index("products") < order.index("sales") and len(order) == 8


@pytest.mark.parametrize("dataset,mode", [("nope", "single"), ("products", "raro")])
def test_invalid_requests_are_rejected(api, dataset, mode):
    with pytest.raises(api.HttpError) as err:
        api.plan_dataset_run(dataset, mode)
    assert err.value.status == 400


@pytest.mark.parametrize("params", [{"bucket": "otro"}, {"bucket": "landing", "prefix": "../x"}, {"bucket": "landing", "prefix": "/abs"}])
def test_list_objects_rejects_unknown_buckets_and_bad_prefixes(api, params, monkeypatch):
    monkeypatch.setattr(api, "_lake_buckets", lambda: {"landing": "b-landing"})
    with pytest.raises(api.HttpError) as err:
        api.list_objects({"queryStringParameters": params})
    assert err.value.status == 400
