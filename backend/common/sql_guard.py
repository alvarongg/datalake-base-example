"""Validación de SQL enviado desde la web (defensa en profundidad).

La web permite ejecutar consultas ad-hoc en Athena. Esta función es la PRIMERA
barrera (solo lectura, una sola sentencia). La SEGUNDA es IAM: el rol de la
API no tiene permisos de escritura sobre los buckets bronze/silver/gold, así
que aunque esta validación se burlara, un CREATE/INSERT fallaría igual.
"""

from __future__ import annotations

import re

MAX_SQL_LENGTH = 5000

_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|"
    r"unload|msck|repair|call|execute|vacuum|optimize)\b",
    re.IGNORECASE,
)


class UnsafeSqlError(ValueError):
    """La consulta no cumple las reglas de solo lectura."""


def validate_select(sql: str) -> str:
    """Devuelve el SQL limpio o lanza ``UnsafeSqlError``."""
    if not isinstance(sql, str) or not sql.strip():
        raise UnsafeSqlError("La consulta está vacía.")
    if len(sql) > MAX_SQL_LENGTH:
        raise UnsafeSqlError(f"La consulta supera {MAX_SQL_LENGTH} caracteres.")

    # Quitamos comentarios para que no se usen para esconder palabras.
    cleaned = re.sub(r"--[^\n]*", " ", sql)
    cleaned = re.sub(r"/\*.*?\*/", " ", cleaned, flags=re.DOTALL).strip()
    cleaned = cleaned.rstrip(";").strip()

    if ";" in cleaned:
        raise UnsafeSqlError("Solo se permite una sentencia por consulta.")
    if not re.match(r"^(select|with)\b", cleaned, re.IGNORECASE):
        raise UnsafeSqlError("Solo se permiten consultas SELECT / WITH.")
    if _FORBIDDEN.search(cleaned):
        raise UnsafeSqlError("La consulta contiene palabras no permitidas (solo lectura).")
    return cleaned
