"""Configuración compartida por todas las Lambdas.

Principio (12-factor): nada de nombres de bucket o base de datos escritos a
mano en el código. CDK inyecta todo como variables de entorno y este módulo
las lee en un único lugar. Así el mismo código corre en cualquier cuenta o
entorno sin cambios.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Prefijo común dentro de cada bucket. Permite que el mismo bucket aloje más
# de un dataset en el futuro (p. ej. "adventureworks/", "ventas_erp/").
DATASET_PREFIX = "adventureworks"


@dataclass(frozen=True)
class Settings:
    landing_bucket: str
    bronze_bucket: str
    silver_bucket: str
    gold_bucket: str
    athena_results_bucket: str
    bronze_db: str
    silver_db: str
    gold_db: str
    athena_workgroup: str

    def landing_uri(self, filename: str) -> str:
        return f"s3://{self.landing_bucket}/{DATASET_PREFIX}/{filename}"

    def table_uri(self, layer: str, table: str) -> str:
        """URI S3 (con '/' final) donde vive una tabla de una capa."""
        bucket = {
            "bronze": self.bronze_bucket,
            "silver": self.silver_bucket,
            "gold": self.gold_bucket,
        }[layer]
        return f"s3://{bucket}/{DATASET_PREFIX}/{table}/"


def get_settings() -> Settings:
    """Lee la configuración desde variables de entorno (falla si falta alguna)."""
    env = os.environ
    return Settings(
        landing_bucket=env["LANDING_BUCKET"],
        bronze_bucket=env["BRONZE_BUCKET"],
        silver_bucket=env["SILVER_BUCKET"],
        gold_bucket=env["GOLD_BUCKET"],
        athena_results_bucket=env["ATHENA_RESULTS_BUCKET"],
        bronze_db=env["BRONZE_DB"],
        silver_db=env["SILVER_DB"],
        gold_db=env["GOLD_DB"],
        athena_workgroup=env["ATHENA_WORKGROUP"],
    )
