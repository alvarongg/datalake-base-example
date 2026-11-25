"""Reglas de "al día" y de dependencias (lógica pura de common/control.py)."""

import pytest

from common.control import (
    DependencyError, check_dependencies, compute_statuses, dataset_status, gold_blockers,
    gold_model_status, landing_version, silver_token,
)
from common.datasets import DATASETS, DATASETS_BY_NAME, dependency_closure
from common.gold_models import load_models

CATEGORIES, SUBCATS, PRODUCTS = (DATASETS_BY_NAME[n] for n in ("product_categories", "product_subcategories", "products"))


def objs(*files, etag="e1"):
    return {f: {"etag": etag, "size": 1} for f in files}


def ctl(version="v1", built_from=None, token="t1", with_silver=True):
    c = {"bronze": {"version": version, "rows": 1}}
    if with_silver:
        c["silver"] = {"version": version, "token": token, "built_from": built_from or {}}
    return c


def test_landing_version_needs_all_files_and_changes_with_content():
    sales = DATASETS_BY_NAME["sales"]
    assert landing_version(sales, objs(*sales.files[:2])) is None  # falta el CSV de 2017
    a = landing_version(sales, objs(*sales.files, etag="a"))
    b = landing_version(sales, objs(*sales.files, etag="b"))
    assert a and b and a != b
    assert a == landing_version(sales, objs(*sales.files, etag="a"))  # estable: re-subir lo mismo no cambia nada


def test_status_progression_for_a_root_table():
    v = "v1"
    assert dataset_status(CATEGORIES, None, {}) == "no_file"
    assert dataset_status(CATEGORIES, v, {}) == "pending"
    assert dataset_status(CATEGORIES, v, {"product_categories": ctl(with_silver=False)}) == "bronze"
    assert dataset_status(CATEGORIES, v, {"product_categories": ctl()}) == "ok"


def test_archived_file_keeps_the_table_up_to_date():
    # Tras Bronze el CSV se mueve a archive/: sin archivo en landing la tabla sigue al día.
    assert dataset_status(CATEGORIES, None, {"product_categories": ctl()}) == "ok"
    assert dataset_status(CATEGORIES, None, {"product_categories": ctl(with_silver=False)}) == "bronze"


def test_gold_only_stale_skips_up_to_date_models_unless_a_parent_is_rebuilt():
    from lambdas.gold.handler import plan_models

    models = load_models()
    all_ok = {d.name: "ok" for d in DATASETS}
    gold = {m.name: "ok" for m in models}
    gold["fact_sales"] = "stale"
    to_build, blocked, skipped = plan_models([], models, all_ok, gold, only_stale=True)
    built = [m.name for m in to_build]
    assert "fact_sales" in built and "sales_monthly_by_category" in built  # el agregado depende de fact_sales
    assert "dim_customer" in skipped and not blocked


def test_new_file_makes_silver_stale():
    assert dataset_status(CATEGORIES, "v2", {"product_categories": ctl("v1")}) == "stale"


def test_child_becomes_stale_when_parent_is_rebuilt():
    controls = {
        "product_categories": ctl(token="cat-1"),
        "product_subcategories": ctl(built_from={"product_categories": "cat-1"}),
    }
    assert dataset_status(SUBCATS, "v1", controls) == "ok"
    controls["product_categories"] = ctl(token="cat-2")  # la tabla padre se reprocesó
    assert dataset_status(SUBCATS, "v1", controls) == "stale"


def test_cannot_process_products_before_its_parents():
    versions = {d.name: "v1" for d in DATASETS}
    statuses = compute_statuses(versions, {})  # nada procesado todavía
    problems = check_dependencies("products", statuses)
    assert [p["dependency"] for p in problems] == ["product_subcategories"]
    assert "nunca se procesó" in problems[0]["reason"]


def test_processing_in_dependency_order_unblocks_each_step():
    versions = {d.name: "v1" for d in DATASETS}
    controls = {}
    for name in dependency_closure("products"):
        statuses = compute_statuses(versions, controls)
        assert check_dependencies(name, statuses) == []  # en orden, siempre se puede
        ds = DATASETS_BY_NAME[name]
        controls[name] = ctl(built_from={d: silver_token(controls[d]) for d in ds.depends_on}, token=f"{name}-1")
    assert compute_statuses(versions, controls)["products"] == "ok"


def test_dependency_error_message_names_the_missing_parent():
    err = DependencyError("products", [{"dependency": "product_subcategories", "reason": "nunca se procesó"}])
    assert "products no se puede procesar" in str(err) and "product_subcategories" in str(err)


def test_gold_model_stale_when_silver_changes():
    m = next(x for x in load_models() if x.name == "dim_product")
    controls = {s: ctl(token=f"{s}-1") for s in m.silver_deps}
    entry = {"at": "x", "built_from": {f"silver:{s}": f"{s}-1" for s in m.silver_deps}}
    assert gold_model_status(m, entry, controls, {}) == "ok"
    assert gold_model_status(m, None, controls, {}) == "not_built"
    controls["products"] = ctl(token="products-2")
    assert gold_model_status(m, entry, controls, {}) == "stale"


def test_gold_blockers_list_silver_and_gold_problems():
    models = {x.name: x for x in load_models()}
    all_ok = {d.name: "ok" for d in DATASETS}
    # fact_sales lee Silver: con sales desactualizada queda bloqueada.
    problems = gold_blockers(models["fact_sales"], {**all_ok, "sales": "stale"}, fresh_gold=set())
    assert [p["dependency"] for p in problems] == ["silver.sales"]
    # un agregado solo lee Gold: se bloquea si sus modelos padre no están al día.
    agg = models["sales_monthly_by_category"]
    problems = gold_blockers(agg, all_ok, fresh_gold={"dim_date"})
    assert {p["dependency"] for p in problems} == {"gold.fact_sales", "gold.dim_product"}
    assert gold_blockers(agg, all_ok, {"fact_sales", "dim_date", "dim_product"}) == []


def test_gold_plan_builds_in_order_and_blocks_the_dependents():
    from lambdas.gold.handler import plan_models

    models = load_models()
    all_ok = {d.name: "ok" for d in DATASETS}
    to_build, blocked, _ = plan_models([], models, all_ok, {m.name: "not_built" for m in models})
    assert [m.name for m in to_build] == [m.name for m in models] and not blocked

    # products desactualizada: dim_product, fact_sales, fact_returns y todo lo que cuelga de ellos quedan bloqueados.
    stale = {**all_ok, "products": "stale"}
    to_build, blocked, _ = plan_models([], models, stale, {m.name: "not_built" for m in models})
    assert "dim_product" in blocked and "fact_sales" in blocked and "sales_monthly_by_category" in blocked
    assert "dim_customer" not in blocked and "dim_customer" in [m.name for m in to_build]


def test_gold_single_model_requires_its_gold_parents_to_exist():
    from lambdas.gold.handler import plan_models

    models = load_models()
    all_ok = {d.name: "ok" for d in DATASETS}
    _, blocked, _ = plan_models(["sales_monthly_by_category"], models, all_ok, {m.name: "not_built" for m in models})
    assert "sales_monthly_by_category" in blocked
    ok_gold = {m.name: ("ok" if m.name != "sales_monthly_by_category" else "not_built") for m in models}
    to_build, blocked, _ = plan_models(["sales_monthly_by_category"], models, all_ok, ok_gold)
    assert [m.name for m in to_build] == ["sales_monthly_by_category"] and not blocked


def test_gold_unknown_model_is_rejected():
    from lambdas.gold.handler import plan_models

    with pytest.raises(ValueError):
        plan_models(["no_existe"], load_models(), {}, {})
