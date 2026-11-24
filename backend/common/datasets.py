"""Catálogo de datasets: el "contrato" entre la carga manual y el pipeline.

Es la única fuente de verdad sobre QUÉ archivos espera el pipeline, cómo se
llaman las tablas resultantes, QUÉ motor transforma cada una en Silver y DE
QUÉ otras tablas depende. La web, la API y las Lambdas importan de aquí.

Se usan dos motores en Silver a propósito, para que los ingenieros vean los escenarios:

* ``pandas``  → tablas pequeñas (dimensiones). Simple y rápido en una Lambda.
* ``glue``    → tablas de hechos grandes. Spark distribuido en AWS Glue.
(Gold usa awswrangler + SQL de Athena, ver backend/lambdas/gold.)

DEPENDENCIAS (``depends_on``): reflejan las claves foráneas del modelo original.
Un pipeline real no procesa una tabla hija si su tabla padre no está al día:
por ejemplo, ``products`` referencia ``product_subcategories``. Si se procesa
products antes de actualizar subcategories, Silver falla (ver common/control.py).
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
    depends_on: tuple[str, ...] = ()  # tablas que deben estar al día en Silver


DATASETS: tuple[Dataset, ...] = (
    Dataset("calendar", ("AdventureWorks_Calendar.csv",), "utf-8", "pandas",
            "Calendario de fechas 2015-2017."),
    Dataset("customers", ("AdventureWorks_Customers.csv",), "latin-1", "pandas",
            "Clientes. Viene en latin-1 (tiene tildes), no en UTF-8."),
    Dataset("territories", ("AdventureWorks_Territories.csv",), "utf-8", "pandas",
            "Territorios de venta."),
    Dataset("product_categories", ("AdventureWorks_Product_Categories.csv",), "utf-8", "pandas",
            "Categorías de producto (Bikes, Components...)."),
    Dataset("product_subcategories", ("AdventureWorks_Product_Subcategories.csv",), "utf-8", "pandas",
            "Subcategorías de producto.", depends_on=("product_categories",)),
    Dataset("products", ("AdventureWorks_Products.csv",), "utf-8", "pandas",
            "Catálogo de productos con costo y precio.", depends_on=("product_subcategories",)),
    Dataset("sales",
            ("AdventureWorks_Sales_2015.csv",
             "AdventureWorks_Sales_2016.csv",
             "AdventureWorks_Sales_2017.csv"),
            "utf-8", "glue",
            "Líneas de venta (un CSV por año, se unifican en una sola tabla).",
            depends_on=("products", "customers", "territories", "calendar")),
    Dataset("returns", ("AdventureWorks_Returns.csv",), "utf-8", "glue",
            "Devoluciones de productos.",
            depends_on=("products", "territories", "calendar")),
)

DATASETS_BY_NAME = {d.name: d for d in DATASETS}

# Todos los archivos que el pipeline acepta. La API usa este conjunto para
# rechazar cualquier otro nombre al generar URLs de subida (validación en el
# borde de confianza).
ALLOWED_FILES: frozenset[str] = frozenset(f for d in DATASETS for f in d.files)

PANDAS_TABLES = tuple(d.name for d in DATASETS if d.silver_engine == "pandas")
GLUE_TABLES = tuple(d.name for d in DATASETS if d.silver_engine == "glue")


def dependency_closure(name: str) -> list[str]:
    """``name`` y todo lo que necesita (directa o indirectamente), en orden de
    procesamiento: primero las tablas sin dependencias, al final ``name``.

    Ej.: dependency_closure("products") -> [product_categories, product_subcategories, products]
    """
    ordered: list[str] = []

    def visit(n: str, trail: tuple[str, ...]) -> None:
        if n in trail:
            raise ValueError(f"Ciclo de dependencias: {' -> '.join(trail + (n,))}")
        for dep in DATASETS_BY_NAME[n].depends_on:
            visit(dep, trail + (n,))
        if n not in ordered:
            ordered.append(n)

    visit(name, ())
    return ordered


def all_in_order() -> list[str]:
    """Todos los datasets en un orden válido (cada uno después de sus dependencias)."""
    ordered: list[str] = []
    for d in DATASETS:
        for n in dependency_closure(d.name):
            if n not in ordered:
                ordered.append(n)
    return ordered


def required_files(names: list[str]) -> list[str]:
    """Archivos CSV necesarios para procesar estos datasets."""
    return [f for n in names for f in DATASETS_BY_NAME[n].files]
