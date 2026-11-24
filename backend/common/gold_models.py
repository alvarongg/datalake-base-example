"""Modelos Gold (archivos SQL) y sus dependencias.

Las dependencias NO se declaran a mano: se leen del propio SQL. Si un modelo
hace ``FROM "{silver_db}"."products"`` depende de la tabla Silver ``products``;
si hace ``JOIN "{gold_db}"."dim_product"`` depende del modelo Gold ``dim_product``.
Así el SQL es la única fuente de verdad y el grafo no se puede desincronizar.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

SQL_DIR = Path(__file__).resolve().parents[1] / "sql" / "gold"

_SILVER_REF = re.compile(r'"\{silver_db\}"\."(\w+)"')
_GOLD_REF = re.compile(r'"\{gold_db\}"\."(\w+)"')


@dataclass(frozen=True)
class GoldModel:
    name: str
    path: Path
    silver_deps: tuple[str, ...]  # tablas Silver que lee
    gold_deps: tuple[str, ...]  # otros modelos Gold que lee


def parse_dependencies(name: str, sql: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    silver = tuple(dict.fromkeys(_SILVER_REF.findall(sql)))
    gold = tuple(dict.fromkeys(g for g in _GOLD_REF.findall(sql) if g != name))
    return silver, gold


def load_models() -> list[GoldModel]:
    """Modelos ordenados por prefijo numérico (01_, 02_, ...)."""
    models = []
    for p in sorted(SQL_DIR.glob("[0-9][0-9]_*.sql")):
        name = p.stem.split("_", 1)[1]
        silver, gold = parse_dependencies(name, p.read_text(encoding="utf-8"))
        models.append(GoldModel(name, p, silver, gold))
    return models


def list_gold_models() -> list[tuple[str, Path]]:
    """[(nombre_tabla, ruta_sql)] en orden de construcción."""
    return [(m.name, m.path) for m in load_models()]


def gold_model_names() -> list[str]:
    return [m.name for m in load_models()]
