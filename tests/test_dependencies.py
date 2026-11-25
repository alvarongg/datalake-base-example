"""Grafo de dependencias entre datasets y modelos Gold."""

import pytest

from common.datasets import (
    DATASETS, DATASETS_BY_NAME, all_in_order, dependency_closure, required_files,
)
from common.gold_models import load_models, parse_dependencies


def test_every_dependency_exists_and_there_are_no_cycles():
    for d in DATASETS:
        for dep in d.depends_on:
            assert dep in DATASETS_BY_NAME, f"{d.name} depende de '{dep}', que no existe"
        dependency_closure(d.name)  # lanza ValueError si hay un ciclo


def test_closure_is_ordered_parents_first():
    assert dependency_closure("products") == ["product_categories", "product_subcategories", "products"]
    assert dependency_closure("calendar") == ["calendar"]


def test_all_in_order_respects_dependencies():
    order = all_in_order()
    assert sorted(order) == sorted(DATASETS_BY_NAME)
    for d in DATASETS:
        for dep in d.depends_on:
            assert order.index(dep) < order.index(d.name)


def test_required_files_for_products_chain():
    assert required_files(dependency_closure("products")) == [
        "AdventureWorks_Product_Categories.csv",
        "AdventureWorks_Product_Subcategories.csv",
        "AdventureWorks_Products.csv",
    ]


def test_gold_dependencies_are_parsed_from_sql():
    models = {m.name: m for m in load_models()}
    assert set(models["dim_product"].silver_deps) == {"products", "product_subcategories", "product_categories"}
    assert models["dim_product"].gold_deps == ()
    assert set(models["fact_sales"].silver_deps) == {"sales", "products"}
    assert set(models["sales_monthly_by_category"].gold_deps) == {"fact_sales", "dim_date", "dim_product"}


def test_gold_silver_deps_are_real_datasets_and_models_are_ordered():
    built = set()
    for m in load_models():
        assert set(m.silver_deps) <= set(DATASETS_BY_NAME)
        assert set(m.gold_deps) <= built, f"{m.name} se construye antes que sus dependencias"
        built.add(m.name)


def test_parse_ignores_self_reference():
    silver, gold = parse_dependencies("x", '"{gold_db}"."x" "{gold_db}"."y" "{silver_db}"."z"')
    assert silver == ("z",) and gold == ("y",)


@pytest.mark.parametrize("name", list(DATASETS_BY_NAME))
def test_pandas_datasets_have_a_transform(name):
    from common.transforms import SILVER_PANDAS_TRANSFORMS

    if DATASETS_BY_NAME[name].silver_engine == "pandas":
        assert name in SILVER_PANDAS_TRANSFORMS
