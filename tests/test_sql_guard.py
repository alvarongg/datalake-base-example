import pytest

from common.sql_guard import UnsafeSqlError, validate_select


@pytest.mark.parametrize("sql", [
    "SELECT 1", "select * from dim_product limit 5;", "WITH a AS (SELECT 1) SELECT * FROM a",
    "-- comentario\nSELECT 1",
])
def test_valid(sql):
    assert validate_select(sql)


@pytest.mark.parametrize("sql", [
    "", "   ", "DROP TABLE x", "SELECT 1; DROP TABLE x", "INSERT INTO t SELECT 1",
    "CREATE TABLE t AS SELECT 1", "SELECT 1 /* x */; SELECT 2", "x" * 6000,
    "WITH a AS (SELECT 1) DELETE FROM t",
])
def test_invalid(sql):
    with pytest.raises(UnsafeSqlError):
        validate_select(sql)
