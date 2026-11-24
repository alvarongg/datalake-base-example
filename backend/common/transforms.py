"""Transformaciones puras con pandas (sin AWS) para Bronze y Silver.

Están separadas de las Lambdas a propósito: son funciones puras
``DataFrame -> DataFrame`` que se pueden testear en local sin credenciales
(ver tests/test_transforms.py). Las Lambdas solo hacen I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import pandas as pd

# ---------------------------------------------------------------- utilidades


class DataQualityError(Exception):
    """Se lanza cuando los datos violan una regla que no se puede corregir."""


@dataclass
class QualityReport:
    """Resumen de calidad de una tabla; se devuelve en el output del pipeline."""

    table: str
    rows_in: int
    rows_out: int
    duplicates_removed: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "table": self.table,
            "rows_in": self.rows_in,
            "rows_out": self.rows_out,
            "duplicates_removed": self.duplicates_removed,
            "notes": self.notes,
        }


def to_snake_case(name: str) -> str:
    """'ProductSKU' -> 'product_sku', 'OrderLineItem' -> 'order_line_item'."""
    name = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "_", name.strip())
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)
    return re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower()


def _blank_to_na(series: pd.Series) -> pd.Series:
    """Texto vacío o solo espacios -> NA (los CSV representan nulos así)."""
    s = series.astype("string").str.strip()
    return s.mask(s == "")


def _to_int(series: pd.Series) -> pd.Series:
    return pd.to_numeric(_blank_to_na(series), errors="raise").astype("Int64")


def _to_float(series: pd.Series) -> pd.Series:
    return pd.to_numeric(_blank_to_na(series), errors="raise").astype("float64")


def _to_date(series: pd.Series) -> pd.Series:
    """Fechas del CSV (formato M/D/YYYY) -> objetos ``date`` (tipo DATE en Athena)."""
    parsed = pd.to_datetime(_blank_to_na(series), format="%m/%d/%Y", errors="raise")
    return parsed.dt.date


def _dedupe(df: pd.DataFrame, key: list[str]) -> tuple[pd.DataFrame, int]:
    """Elimina duplicados por clave (se queda con el último). Devuelve cuántos quitó."""
    before = len(df)
    out = df.drop_duplicates(subset=key, keep="last").reset_index(drop=True)
    return out, before - len(out)


def _require_not_null(df: pd.DataFrame, columns: list[str], table: str) -> None:
    for col in columns:
        n = int(df[col].isna().sum())
        if n:
            raise DataQualityError(f"{table}: la columna obligatoria '{col}' tiene {n} nulos")


# ------------------------------------------------------------------- BRONZE


def to_bronze(df: pd.DataFrame, source_file: pd.Series | str, ingested_at: str) -> pd.DataFrame:
    """Bronze = el dato crudo tal cual llegó + columnas de auditoría.

    Solo se hacen dos cambios, ambos NO destructivos:
    1. Los nombres de columna pasan a snake_case (Glue/Athena no distinguen
       mayúsculas, así evitamos ambigüedades).
    2. Se agregan ``_source_file`` y ``_ingested_at`` para tener *lineage*:
       siempre se sabe de qué archivo y cuándo salió cada fila.

    Los valores NO se tocan: todo queda como texto, incluso fechas y números.
    """
    out = df.copy()
    out.columns = [to_snake_case(c) for c in out.columns]
    out["_source_file"] = source_file
    out["_ingested_at"] = ingested_at
    return out


# ------------------------------------------------------------------- SILVER
# Cada función recibe el DataFrame de Bronze (todo texto) y devuelve el de
# Silver tipado y limpio, más el reporte de calidad.


def silver_customers(df: pd.DataFrame) -> tuple[pd.DataFrame, QualityReport]:
    rows_in = len(df)
    out = pd.DataFrame(
        {
            "customer_key": _to_int(df["customer_key"]),
            "prefix": _blank_to_na(df["prefix"]).str.upper(),
            "first_name": _blank_to_na(df["first_name"]).str.title(),
            "last_name": _blank_to_na(df["last_name"]).str.title(),
            "birth_date": _to_date(df["birth_date"]),
            "marital_status": _blank_to_na(df["marital_status"]).str.upper(),
            "gender": _blank_to_na(df["gender"]).str.upper(),
            "email": _blank_to_na(df["email_address"]).str.lower(),
            # "$90,000 " -> 90000.0
            "annual_income": _to_float(df["annual_income"].str.replace(r"[$,\s]", "", regex=True)),
            "total_children": _to_int(df["total_children"]),
            "education_level": _blank_to_na(df["education_level"]),
            "occupation": _blank_to_na(df["occupation"]),
            "home_owner": _blank_to_na(df["home_owner"]).str.upper().eq("Y").astype("bool"),
        }
    )
    out["full_name"] = (out["first_name"].fillna("") + " " + out["last_name"].fillna("")).str.strip()
    _require_not_null(out, ["customer_key"], "customers")
    out, dups = _dedupe(out, ["customer_key"])
    return out, QualityReport("customers", rows_in, len(out), dups,
                              ["annual_income convertido de '$90,000 ' a número"])


def silver_products(df: pd.DataFrame) -> tuple[pd.DataFrame, QualityReport]:
    rows_in = len(df)
    out = pd.DataFrame(
        {
            "product_key": _to_int(df["product_key"]),
            "product_subcategory_key": _to_int(df["product_subcategory_key"]),
            "product_sku": _blank_to_na(df["product_sku"]),
            "product_name": _blank_to_na(df["product_name"]),
            "model_name": _blank_to_na(df["model_name"]),
            "product_description": _blank_to_na(df["product_description"]),
            "product_color": _blank_to_na(df["product_color"]),
            # En el origen "0" significa "no aplica": lo modelamos como NULL.
            "product_size": _blank_to_na(df["product_size"]).mask(lambda s: s == "0"),
            "product_style": _blank_to_na(df["product_style"]).mask(lambda s: s == "0"),
            "product_cost": _to_float(df["product_cost"]),
            "product_price": _to_float(df["product_price"]),
        }
    )
    _require_not_null(out, ["product_key", "product_cost", "product_price"], "products")
    out, dups = _dedupe(out, ["product_key"])
    return out, QualityReport("products", rows_in, len(out), dups,
                              ["size/style '0' convertido a NULL"])


def silver_product_categories(df: pd.DataFrame) -> tuple[pd.DataFrame, QualityReport]:
    rows_in = len(df)
    out = pd.DataFrame(
        {
            "product_category_key": _to_int(df["product_category_key"]),
            "category_name": _blank_to_na(df["category_name"]),
        }
    )
    _require_not_null(out, ["product_category_key"], "product_categories")
    out, dups = _dedupe(out, ["product_category_key"])
    return out, QualityReport("product_categories", rows_in, len(out), dups)


def silver_product_subcategories(df: pd.DataFrame) -> tuple[pd.DataFrame, QualityReport]:
    rows_in = len(df)
    out = pd.DataFrame(
        {
            "product_subcategory_key": _to_int(df["product_subcategory_key"]),
            "subcategory_name": _blank_to_na(df["subcategory_name"]),
            "product_category_key": _to_int(df["product_category_key"]),
        }
    )
    _require_not_null(out, ["product_subcategory_key"], "product_subcategories")
    out, dups = _dedupe(out, ["product_subcategory_key"])
    return out, QualityReport("product_subcategories", rows_in, len(out), dups)


def silver_territories(df: pd.DataFrame) -> tuple[pd.DataFrame, QualityReport]:
    rows_in = len(df)
    out = pd.DataFrame(
        {
            "sales_territory_key": _to_int(df["sales_territory_key"]),
            "region": _blank_to_na(df["region"]),
            "country": _blank_to_na(df["country"]),
            "continent": _blank_to_na(df["continent"]),
        }
    )
    _require_not_null(out, ["sales_territory_key"], "territories")
    out, dups = _dedupe(out, ["sales_territory_key"])
    return out, QualityReport("territories", rows_in, len(out), dups)


def silver_calendar(df: pd.DataFrame) -> tuple[pd.DataFrame, QualityReport]:
    """Calendario enriquecido: además de tipar, deriva atributos de fecha."""
    rows_in = len(df)
    dates = pd.to_datetime(_blank_to_na(df["date"]), format="%m/%d/%Y", errors="raise")
    out = pd.DataFrame(
        {
            "date": dates.dt.date,
            "year": dates.dt.year.astype("int32"),
            "quarter": dates.dt.quarter.astype("int32"),
            "month": dates.dt.month.astype("int32"),
            "month_name": dates.dt.month_name(),
            "year_month": dates.dt.strftime("%Y-%m"),
            "day": dates.dt.day.astype("int32"),
            "day_of_week": dates.dt.day_name(),
            "is_weekend": dates.dt.day_of_week.ge(5),
        }
    )
    out, dups = _dedupe(out, ["date"])
    return out, QualityReport("calendar", rows_in, len(out), dups)


# Registro: tabla -> función de limpieza. La Lambda de Silver itera sobre esto.
SILVER_PANDAS_TRANSFORMS = {
    "calendar": silver_calendar,
    "customers": silver_customers,
    "product_categories": silver_product_categories,
    "product_subcategories": silver_product_subcategories,
    "products": silver_products,
    "territories": silver_territories,
}
