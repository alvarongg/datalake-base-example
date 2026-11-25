"""Reglas del flujo event-driven (common/events.py) y del plan programado: sin AWS."""

import io
import json
from datetime import datetime, timezone

import pytest

from common.datasets import DATASETS, DATASETS_BY_NAME
from common.events import (
    S3Lock, append_feed, archive_key, bronze_precheck, dataset_for_key, gold_precheck, latest_archived,
    next_after_gold, next_after_silver, parse_archive_key, parse_messages, silver_precheck, step_message,
)
from common.gold_models import load_models

SALES = DATASETS_BY_NAME["sales"]
MODELS = {m.name: m for m in load_models()}


# ------------------------------------------------------------------ mensajes

def test_parse_s3_notification_decodes_key_and_etag():
    body = json.dumps({"Records": [{"eventName": "ObjectCreated:Put", "eventTime": "t",
                                    "s3": {"object": {"key": "adventureworks/AdventureWorks_Sales_2015.csv", "eTag": "abc", "size": 10}}}]})
    [m] = parse_messages(body)
    assert m == {"type": "s3", "key": "adventureworks/AdventureWorks_Sales_2015.csv", "etag": "abc", "size": 10, "eventTime": "t"}


def test_parse_test_event_glue_event_and_step():
    assert parse_messages(json.dumps({"Event": "s3:TestEvent"})) == [{"type": "test"}]
    glue = {"source": "aws.glue", "detail": {"jobName": "j", "jobRunId": "r", "state": "SUCCEEDED"}}
    assert parse_messages(json.dumps(glue))[0]["state"] == "SUCCEEDED"
    step = step_message("silver", "products", "evt:1")
    assert parse_messages(json.dumps(step)) == [step]
    with pytest.raises(ValueError):
        parse_messages(json.dumps({"hola": 1}))


def test_dataset_for_key_ignores_archive_and_unknown_files():
    assert dataset_for_key("adventureworks/AdventureWorks_Products.csv")[1].name == "products"
    assert dataset_for_key("archive/adventureworks/AdventureWorks_Products.csv")[1] is None
    assert dataset_for_key("adventureworks/otro.csv")[1] is None


def test_archive_key_round_trip_and_latest():
    when = datetime(2026, 11, 25, 12, 30, 5, tzinfo=timezone.utc)
    key = archive_key("AdventureWorks_Products.csv", when)
    assert key == "archive/adventureworks/AdventureWorks_Products__procesado_20261125T123005Z.csv"
    assert parse_archive_key(key) == ("AdventureWorks_Products.csv", "20261125T123005Z")
    older = archive_key("AdventureWorks_Products.csv", datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert latest_archived([older, key, "archive/adventureworks/raro.csv"]) == {"AdventureWorks_Products.csv": key}


# --------------------------------------------------------------- decisiones

def landing(*files):
    return {f: {"etag": f"e-{f}"} for f in files}


def test_bronze_waits_for_the_other_sales_files():
    decision, missing = bronze_precheck(SALES, SALES.files[0], "x", landing(SALES.files[0]), {})
    assert decision == "waiting" and missing == list(SALES.files[1:])


def test_bronze_ready_when_all_files_are_present():
    assert bronze_precheck(SALES, SALES.files[0], "x", landing(*SALES.files), {})[0] == "ready"


def test_bronze_missing_trigger_file_is_an_error():
    assert bronze_precheck(SALES, SALES.files[0], "x", {}, {})[0] == "error"


def test_bronze_duplicate_event_after_archive_is_skipped():
    consumed = {SALES.files[1]: "etag-2016"}
    assert bronze_precheck(SALES, SALES.files[1], "etag-2016", {}, consumed)[0] == "skip"
    # mismo nombre pero otro contenido (otro ETag) y sin archivo: sí es error
    assert bronze_precheck(SALES, SALES.files[1], "otro", {}, consumed)[0] == "error"


def test_silver_precheck():
    st = {d.name: "ok" for d in DATASETS}
    assert silver_precheck("products", st)[0] == "skip"
    st["products"] = "bronze"
    st["product_subcategories"] = "pending"
    decision, problems = silver_precheck("products", st)
    assert decision == "waiting" and problems[0]["dependency"] == "product_subcategories"
    st["product_subcategories"] = "ok"
    assert silver_precheck("products", st)[0] == "ready"
    st["sales"] = "no_file"
    assert silver_precheck("sales", st)[0] == "skip"


def test_gold_precheck():
    silver = {d.name: "ok" for d in DATASETS}
    gold = {m: "not_built" for m in MODELS}
    assert gold_precheck(MODELS["dim_product"], silver, gold)[0] == "ready"
    decision, problems = gold_precheck(MODELS["sales_monthly_by_category"], silver, gold)
    assert decision == "waiting" and {p["dependency"] for p in problems} == {"gold.fact_sales", "gold.dim_date", "gold.dim_product"}
    gold["dim_product"] = "ok"
    assert gold_precheck(MODELS["dim_product"], silver, gold)[0] == "skip"


def test_fan_out():
    st = {d.name: "ok" for d in DATASETS}
    st["product_subcategories"] = "stale"
    children, models = next_after_silver("product_categories", st)
    assert children == ["product_subcategories"] and models == ["dim_product"]
    assert next_after_gold("fact_returns") == ["return_rate_by_category"]


# --------------------------------------------------- concurrencia con S3 falso

class Conflict(Exception):
    response = {"Error": {"Code": "PreconditionFailed"}}


class NoSuchKey(Exception):
    pass


class FakeS3:
    """Simula las escrituras condicionales de S3 (If-None-Match / If-Match)."""

    def __init__(self):
        self.objs: dict[str, tuple[bytes, str]] = {}
        self.n = 0

    def put_object(self, Bucket, Key, Body, IfNoneMatch=None, IfMatch=None, **_):
        if IfNoneMatch == "*" and Key in self.objs:
            raise Conflict()
        if IfMatch is not None and (Key not in self.objs or self.objs[Key][1] != IfMatch):
            raise Conflict()
        self.n += 1
        self.objs[Key] = (Body, f"etag{self.n}")

    def get_object(self, Bucket, Key):
        if Key not in self.objs:
            raise NoSuchKey()
        body, etag = self.objs[Key]
        return {"Body": io.BytesIO(body), "ETag": etag}

    def delete_object(self, Bucket, Key):
        self.objs.pop(Key, None)


def test_lock_is_exclusive_reentrant_and_expires():
    s3 = FakeS3()
    a, b = S3Lock(s3, "b", "dataset-products", "A", ttl=60), S3Lock(s3, "b", "dataset-products", "B", ttl=60)
    assert a.acquire(now=0) and a.acquire(now=1)  # reentrante para el mismo dueño
    assert not b.acquire(now=10)
    assert b.acquire(now=120)  # el de A expiró
    b.release()
    assert a.acquire(now=130)


def test_feed_appends_newest_first_with_optimistic_concurrency():
    s3 = FakeS3()
    for i in range(3):
        append_feed(s3, "b", {"i": i}, max_entries=2)
    data = json.loads(s3.get_object(Bucket="b", Key="progress/events.json")["Body"].read())
    assert data == [{"i": 2}, {"i": 1}]


# ------------------------------------------------------------ plan programado

def test_scheduled_plan_includes_new_files_and_their_children_in_order():
    from lambdas.schedule_plan.handler import plan_datasets

    controls = {d.name: {"bronze": {"version": "v1"}, "silver": {"version": "v1"}} for d in DATASETS}
    versions = {d.name: None for d in DATASETS}
    statuses = {d.name: "ok" for d in DATASETS}
    assert plan_datasets(versions, controls, statuses) == []  # nada nuevo
    versions["products"] = "v2"  # llegó un products nuevo
    statuses["products"] = "stale"
    plan = plan_datasets(versions, controls, statuses)
    assert plan == ["products", "sales", "returns"]
