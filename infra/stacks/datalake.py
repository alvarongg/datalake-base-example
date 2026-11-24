"""El data lake: un bucket por capa + catálogo de Glue + workgroup de Athena.

   landing  -> los CSV tal como los sube el usuario (zona de aterrizaje)
   bronze   -> dato crudo en Parquet + auditoría
   silver   -> dato limpio y tipado
   gold     -> dato modelado para el negocio
   athena-results -> resultados temporales de consultas Athena

Un bucket por capa permite dar permisos distintos a cada una (principio de
mínimo privilegio): por ejemplo, la API puede LEER gold pero nunca escribirlo.
"""

from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack, aws_athena as athena, aws_glue as glue, aws_s3 as s3
from constructs import Construct

# Nombres fijos y legibles: aparecen en Athena y en las consultas de ejemplo.
BRONZE_DB = "datalake_bronze"
SILVER_DB = "datalake_silver"
GOLD_DB = "datalake_gold"
WORKGROUP = "datalake-demo"


class DataLakeStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, web_origin: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        self.landing = self._bucket("Landing")
        self.bronze = self._bucket("Bronze")
        self.silver = self._bucket("Silver")
        self.gold = self._bucket("Gold")
        self.athena_results = self._bucket("AthenaResults", expire_after=Duration.days(7))

        # El navegador sube los CSV directo a S3 con una URL prefirmada (PUT),
        # lo que exige permitir CORS solo para el origen de nuestra web.
        self.landing.add_cors_rule(
            allowed_methods=[s3.HttpMethods.PUT],
            allowed_origins=[web_origin, "http://localhost:5173"],
            allowed_headers=["*"],
            exposed_headers=["ETag"],
            max_age=3000,
        )

        # Bases de datos del Glue Data Catalog (una por capa).
        self.bronze_db = BRONZE_DB
        self.silver_db = SILVER_DB
        self.gold_db = GOLD_DB
        for name, layer in ((BRONZE_DB, "Bronze"), (SILVER_DB, "Silver"), (GOLD_DB, "Gold")):
            glue.CfnDatabase(
                self, f"{layer}Database",
                catalog_id=self.account,
                database_input=glue.CfnDatabase.DatabaseInputProperty(
                    name=name, description=f"Capa {layer} del data lake de ejemplo (Adventure Works)."
                ),
            )

        # Workgroup de Athena. enforce_work_group_configuration=False es necesario
        # porque los CTAS de Gold definen su propio external_location.
        self.workgroup = WORKGROUP
        athena.CfnWorkGroup(
            self, "Workgroup",
            name=WORKGROUP,
            recursive_delete_option=True,
            work_group_configuration=athena.CfnWorkGroup.WorkGroupConfigurationProperty(
                enforce_work_group_configuration=False,
                publish_cloud_watch_metrics_enabled=True,
                bytes_scanned_cutoff_per_query=10 * 1024**3,  # corta consultas > 10 GB (control de costo)
                result_configuration=athena.CfnWorkGroup.ResultConfigurationProperty(
                    output_location=f"s3://{self.athena_results.bucket_name}/",
                ),
            ),
        )

        for label, bucket in (("Landing", self.landing), ("Bronze", self.bronze), ("Silver", self.silver),
                              ("Gold", self.gold), ("AthenaResults", self.athena_results)):
            CfnOutput(self, f"{label}BucketName", value=bucket.bucket_name)
        CfnOutput(self, "AthenaWorkgroup", value=WORKGROUP)

    def _bucket(self, name: str, expire_after: Duration | None = None) -> s3.Bucket:
        return s3.Bucket(
            self, f"{name}Bucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,  # demo: `cdk destroy` borra datos también
            auto_delete_objects=True,
            lifecycle_rules=[s3.LifecycleRule(expiration=expire_after)] if expire_after else None,
        )
