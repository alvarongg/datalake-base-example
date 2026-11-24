"""Tests de las transformaciones Bronze/Silver con los CSV reales de sample-data."""

import pandas as pd
import pytest

from common.datasets import DATASETS
from common.transforms import (
    DataQualityError,
    SILVER_PANDAS_TRANSFORMS,
    to_bronze,
    to_snake_case,
)
from pathlib import Path

SAMPLE = Path(__file__).resolve().parents[1] / "sample-data"


def bronze_of(table: str) -> pd.DataFrame:
    ds = next(d for d in DATASETS if d.name == table)
    frames = [
        to_bronze(pd.read_csv(SAMPLE / f, dtype=str, keep_default_na=False, encoding=ds.encoding), f, "t0")
        for f in ds.files
    ]
    return pd.concat(frames, ignore_index=True).drop(columns=["_source_file", "_ingested_at"])


@pytest.mark.parametrize("raw,expected", [
    ("ProductSKU", "product_sku"), ("OrderLineItem", "order_line_item"),
    ("EmailAddress", "email_address"), ("Date", "date"),
])
def test_snake_case(raw, expected):
    assert to_snake_case(raw) == expected


def test_bronze_keeps_values_and_adds_audit_columns():
    raw = pd.DataFrame({"CustomerKey": ["1"], "AnnualIncome": ["$90,000 "]})
    out = to_bronze(raw, "f.csv", "2026-01-01T00:00:00+00:00")
    assert out.loc[0, "annual_income"] == "$90,000 "  # valor intacto
    assert out.loc[0, "_source_file"] == "f.csv"
    assert out.loc[0, "_ingested_at"].startswith("2026")


def test_customers_cleaning():
    df, rep = SILVER_PANDAS_TRANSFORMS["customers"](bronze_of("customers"))
    assert rep.rows_out == 18148 and rep.duplicates_removed == 0
    assert df.loc[df.customer_key == 11000, "annual_income"].iloc[0] == 90000.0
    assert df["email"].str.islower().all()
    assert df["home_owner"].dtype == bool


def test_products_zero_means_null():
    df, _ = SILVER_PANDAS_TRANSFORMS["products"](bronze_of("products"))
    assert not (df["product_size"] == "0").any()
    assert df["product_size"].isna().any()
    assert (df["product_price"] > 0).all()


def test_calendar_derived_columns():
    df, rep = SILVER_PANDAS_TRANSFORMS["calendar"](bronze_of("calendar"))
    assert rep.rows_out == 912
    row = df[df["date"].astype(str) == "2015-01-01"].iloc[0]
    assert (row.year, row.quarter, row.month, row.year_month) == (2015, 1, 1, "2015-01")


def test_duplicates_are_removed_and_reported():
    b = bronze_of("territories")
    b = pd.concat([b, b.iloc[[0]]], ignore_index=True)
    df, rep = SILVER_PANDAS_TRANSFORMS["territories"](b)
    assert rep.duplicates_removed == 1 and len(df) == 10


def test_null_primary_key_fails():
    b = bronze_of("product_categories")
    b.loc[0, "product_category_key"] = ""
    with pytest.raises(DataQualityError):
        SILVER_PANDAS_TRANSFORMS["product_categories"](b)


def test_every_pandas_table_has_a_transform():
    pandas_tables = {d.name for d in DATASETS if d.silver_engine == "pandas"}
    assert pandas_tables == set(SILVER_PANDAS_TRANSFORMS)
