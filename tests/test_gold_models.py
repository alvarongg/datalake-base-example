"""Los modelos Gold son plantillas SQL: validamos que se renderizan y que el orden respeta dependencias."""

import re

from lambdas.gold.handler import list_gold_models


def test_models_render_and_are_ctas():
    models = list_gold_models()
    assert len(models) == 10
    for table, path in models:
        sql = path.read_text(encoding="utf-8").format(gold_db="g", silver_db="s", location="s3://b/x/")
        assert f'CREATE TABLE "g"."{table}"' in sql
        assert "external_location = 's3://b/x/'" in sql


def test_dependencies_are_built_before_use():
    built = set()
    for table, path in list_gold_models():
        sql = path.read_text(encoding="utf-8")
        for used in re.findall(r'"\{gold_db\}"\."(\w+)"', sql):
            if used != table:
                assert used in built, f"{table} usa {used} antes de crearla"
        built.add(table)
