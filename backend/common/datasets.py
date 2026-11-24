"""Catálogo de datasets: el "contrato" entre la carga manual y el pipeline.

Es la única fuente de verdad sobre QUÉ archivos espera el pipeline, cómo se
llaman las tablas resultantes y QUÉ motor de procesamiento transforma cada
una en la capa Silver. La web, la API y las Lambdas importan de aquí.

Se usan tres motores a propósito, para que los ingenieros vean los escenarios:

* ``pandas``  → tablas pequeñas (dimensiones). Simple y rápido en una Lambda.
* ``glue``    → tablas de hechos grandes. Spark distribuido en AWS Glue.
* Gold usa awswrangler + SQL de Athena (ver backend/lambdas/gold).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Dataset:
    name: str  # nombre de la tabla (igual en bronze y silver)
    files: tuple[str, ...]  # archivos CSV esperados en landing
    encoding: str  # codificación del CSV (¡no todos son UTF-8!)
    silver_engine: str  # "pandas" | "glue"
    description: str  # texto que se muestra en la web


DATASETS: tuple[Dataset, ...] = (
    Dataset("calendar", ("AdventureWorks_Calendar.csv",), "utf-8", "pandas",
            "Calendario de fechas 2015-2017."),
    Dataset("customers", ("AdventureWorks_Customers.csv",), "latin-1", "pandas",
            "Clientes. Viene en latin-1 (tiene tildes), no en UTF-8."),
    Dataset("product_categories", ("AdventureWorks_Product_Categories.csv",), "utf-8", "pandas",
            "Categorías de producto (Bikes, Components...)."),
    Dataset("product_subcategories", ("AdventureWorks_Product_Subcategories.csv",), "utf-8", "pandas",
            "Subcategorías de producto."),
    Dataset("products", ("AdventureWorks_Products.csv",), "utf-8", "pandas",
            "Catálogo de productos con costo y precio."),
    Dataset("territories", ("AdventureWorks_Territories.csv",), "utf-8", "pandas",
            "Territorios de venta."),
    Dataset("returns", ("AdventureWorks_Returns.csv",), "utf-8", "glue",
            "Devoluciones de productos."),
    Dataset("sales",
            ("AdventureWorks_Sales_2015.csv",
             "AdventureWorks_Sales_2016.csv",
             "AdventureWorks_Sales_2017.csv"),
            "utf-8", "glue",
            "Líneas de venta (un CSV por año, se unifican en una sola tabla)."),
)

DATASETS_BY_NAME = {d.name: d for d in DATASETS}

# Todos los archivos que el pipeline acepta. La API usa este conjunto para
# rechazar cualquier otro nombre al generar URLs de subida (validación en el
# borde de confianza).
ALLOWED_FILES: frozenset[str] = frozenset(f for d in DATASETS for f in d.files)

PANDAS_TABLES = tuple(d.name for d in DATASETS if d.silver_engine == "pandas")
GLUE_TABLES = tuple(d.name for d in DATASETS if d.silver_engine == "glue")
