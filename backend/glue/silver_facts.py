"""CAPA SILVER (escenario 2: AWS Glue / Spark) - tablas de hechos grandes.

¿Por qué Glue aquí? Las tablas de hechos (ventas, devoluciones) son las que
crecen sin límite. Spark reparte el trabajo en varios nodos, así que este
mismo script escala de 56 mil filas a miles de millones sin cambiar código.
Con el volumen de este ejemplo una Lambda alcanzaría, pero se usa Glue para
mostrar al equipo cómo luce el escenario "grande".

Entrada : tablas Bronze (Glue Catalog, todo texto).
Salida  : tablas Silver (Parquet) tipadas, deduplicadas y validadas.

Argumentos del job (los pasa CDK):
  --bronze_database  --silver_database  --silver_path (s3://bucket/prefijo)
"""

import sys

from awsglue.context import GlueContext
from awsglue.dynamicframe import DynamicFrame
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import DataFrame
from pyspark.sql import functions as F

args = getResolvedOptions(sys.argv, ["JOB_NAME", "bronze_database", "silver_database", "silver_path"])

sc = SparkContext()
glue_context = GlueContext(sc)
spark = glue_context.spark_session
job = Job(glue_context)
job.init(args["JOB_NAME"], args)

DATE_FORMAT = "M/d/yyyy"  # formato de fecha del CSV original


class DataQualityError(Exception):
    """Datos que violan una regla no corregible: el job debe fallar."""


def read_bronze(table: str) -> DataFrame:
    """Lee una tabla Bronze a través del Glue Data Catalog."""
    return glue_context.create_dynamic_frame.from_catalog(
        database=args["bronze_database"], table_name=table
    ).toDF()


def to_date(column: str) -> F.Column:
    return F.to_date(F.trim(F.col(column)), DATE_FORMAT)


def assert_no_nulls(df: DataFrame, columns: list, table: str) -> None:
    """Falla el job si una columna obligatoria quedó nula (p. ej. fecha mal parseada)."""
    for col in columns:
        n = df.filter(F.col(col).isNull()).count()
        if n:
            raise DataQualityError(f"{table}: '{col}' tiene {n} nulos tras la conversión de tipos")


def write_silver(df: DataFrame, table: str, partition_keys: list = None) -> None:
    """Escribe Parquet en S3 y crea/actualiza la tabla en el Glue Catalog.

    Idempotencia: primero se purga la carpeta destino; así, re-ejecutar el job
    nunca duplica filas (el "sink" de Glue solo agrega archivos).
    """
    path = f"{args['silver_path'].rstrip('/')}/{table}/"
    glue_context.purge_s3_path(path, options={"retentionPeriod": 0})

    sink = glue_context.getSink(
        connection_type="s3",
        path=path,
        enableUpdateCatalog=True,
        updateBehavior="UPDATE_IN_DATABASE",
        partitionKeys=partition_keys or [],
    )
    sink.setFormat("glueparquet", compression="snappy")
    sink.setCatalogInfo(catalogDatabase=args["silver_database"], catalogTableName=table)
    sink.writeFrame(DynamicFrame.fromDF(df, glue_context, table))


def build_sales(raw: DataFrame) -> DataFrame:
    out = (
        raw.select(
            F.trim("order_number").alias("order_number"),
            F.col("order_line_item").cast("int").alias("order_line_item"),
            to_date("order_date").alias("order_date"),
            to_date("stock_date").alias("stock_date"),
            F.col("product_key").cast("int").alias("product_key"),
            F.col("customer_key").cast("int").alias("customer_key"),
            F.col("territory_key").cast("int").alias("territory_key"),
            F.col("order_quantity").cast("int").alias("order_quantity"),
            F.col("_source_file").alias("source_file"),  # lineage hacia el CSV de origen
        )
        # Regla de negocio: una línea sin cantidad positiva no es una venta.
        .filter(F.col("order_quantity") > 0)
        # Deduplicación por clave natural (pedido + línea).
        .dropDuplicates(["order_number", "order_line_item"])
        # Columna de partición: Athena podrá saltarse años enteros al filtrar.
        .withColumn("order_year", F.year("order_date"))
    )
    assert_no_nulls(out, ["order_number", "order_date", "product_key", "customer_key"], "sales")
    return out


def build_returns(raw: DataFrame) -> DataFrame:
    out = (
        raw.select(
            to_date("return_date").alias("return_date"),
            F.col("territory_key").cast("int").alias("territory_key"),
            F.col("product_key").cast("int").alias("product_key"),
            F.col("return_quantity").cast("int").alias("return_quantity"),
            F.col("_source_file").alias("source_file"),
        )
        .filter(F.col("return_quantity") > 0)
        # Las devoluciones no tienen clave propia; un duplicado exacto es un error de carga.
        .dropDuplicates(["return_date", "territory_key", "product_key", "return_quantity"])
    )
    assert_no_nulls(out, ["return_date", "product_key"], "returns")
    return out


sales = build_sales(read_bronze("sales"))
returns = build_returns(read_bronze("returns"))

print(f"silver.sales filas={sales.count()} | silver.returns filas={returns.count()}")

write_silver(sales, "sales", partition_keys=["order_year"])
write_silver(returns, "returns")

job.commit()
