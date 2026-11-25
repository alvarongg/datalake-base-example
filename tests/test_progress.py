"""Seguimiento de progreso: usa un cliente S3 falso, sin credenciales."""

import json

import pytest

from common.progress import DatasetProgress, GoldProgress


class FakeS3:
    def __init__(self, fail=False):
        self.objects, self.fail = {}, fail

    def put_object(self, Bucket, Key, Body, ContentType):
        if self.fail:
            raise RuntimeError("S3 caído")
        self.objects[Key] = Body

    def get_object(self, Bucket, Key):
        import io
        if Key not in self.objects:
            raise KeyError(Key)
        return {"Body": io.BytesIO(self.objects[Key])}

    def doc(self, key):
        return json.loads(self.objects[key])


def test_reset_leaves_every_stage_pending_for_this_execution():
    s3 = FakeS3()
    DatasetProgress("b", "products", "exec-1", "pandas", client=s3).reset()
    doc = s3.doc("progress/products.json")
    assert doc["executionId"] == "exec-1" and "queuedAt" in doc
    assert {k: v["status"] for k, v in doc["stages"].items()} == {
        "bronze": "pending", "dependencies": "pending", "silver": "pending"}


def test_stage_goes_running_then_succeeded_with_rows():
    s3 = FakeS3()
    p = DatasetProgress("b", "products", "e", "pandas", client=s3)
    with p.stage("bronze") as info:
        assert s3.doc("progress/products.json")["stages"]["bronze"]["status"] == "running"
        info["rows"] = 293
    st = s3.doc("progress/products.json")["stages"]
    assert st["bronze"]["status"] == "succeeded" and st["bronze"]["rows"] == 293
    assert st["silver"]["status"] == "pending"


def test_failed_stage_keeps_detail_and_reraises():
    s3 = FakeS3()
    p = DatasetProgress("b", "products", "e", "pandas", client=s3)
    with pytest.raises(ValueError):
        with p.stage("dependencies") as info:
            info["detail"] = [{"dependency": "product_subcategories", "status": "pending"}]
            raise ValueError("falta product_subcategories")
    st = s3.doc("progress/products.json")["stages"]["dependencies"]
    assert st["status"] == "failed" and "product_subcategories" in st["error"] and st["detail"]


def test_each_lambda_resumes_the_same_execution_file():
    s3 = FakeS3()
    first = DatasetProgress.load("b", "sales", "e1", "glue", client=s3)
    with first.stage("bronze") as info:
        info["rows"] = 5
    second = DatasetProgress.load("b", "sales", "e1", "glue", client=s3)  # otra Lambda, misma ejecución
    with second.stage("dependencies"):
        pass
    st = s3.doc("progress/sales.json")["stages"]
    assert st["bronze"]["status"] == "succeeded" and st["dependencies"]["status"] == "succeeded"
    other_run = DatasetProgress.load("b", "sales", "e2", "glue", client=s3)  # ejecución distinta: empieza limpio
    assert other_run.doc["stages"]["bronze"]["status"] == "pending"


def test_progress_errors_never_break_the_pipeline():
    p = DatasetProgress("b", "products", "e", "pandas", client=FakeS3(fail=True))
    with p.stage("bronze") as info:  # no debe lanzar aunque S3 falle
        info["rows"] = 1


def test_gold_progress_writes_one_file_per_model():
    s3 = FakeS3()
    g = GoldProgress("b", "e", ["dim_product", "fact_sales"], client=s3)
    g.flush()
    g.block("fact_sales", "falta products", [{"dependency": "silver.sales"}])
    with g.table("dim_product"):
        pass
    assert s3.doc("progress/gold/dim_product.json")["status"] == "succeeded"
    blocked = s3.doc("progress/gold/fact_sales.json")
    assert blocked["status"] == "blocked" and blocked["detail"] and blocked["executionId"] == "e"


def test_wait_marks_the_stage_as_waiting_with_attempts():
    s3 = FakeS3()
    p = DatasetProgress("b", "products", "evt:x", "pandas", client=s3)
    p.wait("dependencies", 3, 15, "Esperando", [{"dependency": "product_subcategories"}])
    st = s3.doc("progress/products.json")["stages"]["dependencies"]
    assert st["status"] == "waiting" and st["attempt"] == 3 and st["maxAttempts"] == 15
