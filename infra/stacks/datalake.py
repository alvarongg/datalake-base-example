"""El data lake: un bucket por capa + catálogo de Glue + workgroup de Athena.

   landing  -> los CSV tal como los sube el usuario (zona de aterrizaje)
   bronze   -> dato crudo en Parquet + auditoría
   silver   -> dato limpio y tipado
   gold     -> dato modelado para el negocio
   athena-results -> resultados temporales de consultas Athena

Un bucket por capa permite dar permisos distintos a cada una (principio de
mínimo privilegio): por ejemplo, la API puede LEER gold pero nunca escribirlo.

Colas del flujo EVENT-DRIVEN (viven aquí porque S3 notifica directo a la cola):

   events      -> recibe los PUT de landing (S3), los fines de Glue (EventBridge)
                  y los "siguiente paso" que publica el despachador
   retry-dlq   -> DLQ de reintento: entrega cada mensaje 20 s después; el despachador
                  vuelve a probar si las condiciones se cumplen
   dead-letter -> DLQ final: errores (ej. archivo ausente) y reintentos agotados

Cifrado: SSE-SQS y SSE-S3 (claves administradas por AWS, sin costo). En
producción se usaría una clave propia de KMS (CMK) con rotación; aquí no se
despliega para no sumar costo (~1 USD/mes por clave + llamadas).
"""

from aws_cdk import (CfnOutput, Duration, RemovalPolicy, Stack, aws_athena as athena, aws_glue as glue, aws_iam as iam,
                     aws_s3 as s3, aws_s3_notifications as s3n, aws_sqs as sqs)
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
        # Solo los resultados de consultas expiran: control/, progress/ y locks/ deben persistir.
        self.athena_results = self._bucket("AthenaResults", expire_prefix=("query-results/", Duration.days(7)))

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
                    output_location=f"s3://{self.athena_results.bucket_name}/query-results/",
                ),
            ),
        )

        self._event_queues()

        for label, bucket in (("Landing", self.landing), ("Bronze", self.bronze), ("Silver", self.silver),
                              ("Gold", self.gold), ("AthenaResults", self.athena_results)):
            CfnOutput(self, f"{label}BucketName", value=bucket.bucket_name)
        CfnOutput(self, "AthenaWorkgroup", value=WORKGROUP)

    def _event_queues(self) -> None:
        def queue(cid: str, name: str, **kw) -> sqs.Queue:
            return sqs.Queue(self, cid, queue_name=name, encryption=sqs.QueueEncryption.SQS_MANAGED,
                             enforce_ssl=True, removal_policy=RemovalPolicy.DESTROY, **kw)

        self.dead_letter = queue("DeadLetterQueue", "datalake-demo-dead-letter", retention_period=Duration.days(14))
        # Un mensaje que hace fallar a la Lambda 3 veces (error inesperado) termina en la DLQ final.
        redrive = sqs.DeadLetterQueue(max_receive_count=3, queue=self.dead_letter)
        # visibility = 6 x timeout del despachador (2 min): recomendación de AWS para SQS + Lambda.
        self.events_queue = queue("EventsQueue", "datalake-demo-events",
                                  visibility_timeout=Duration.minutes(12), dead_letter_queue=redrive)
        self.retry_queue = queue("RetryQueue", "datalake-demo-retry-dlq", delivery_delay=Duration.seconds(20),
                                 visibility_timeout=Duration.minutes(12), dead_letter_queue=redrive)

        # PUT de un CSV en landing/adventureworks/ -> mensaje en la cola (archive/ no dispara nada).
        self.landing.add_event_notification(
            s3.EventType.OBJECT_CREATED, s3n.SqsDestination(self.events_queue),
            s3.NotificationKeyFilter(prefix="adventureworks/", suffix=".csv"))

        # EventBridge (fin de jobs de Glue) puede escribir en la cola, solo desde esta cuenta.
        self.events_queue.add_to_resource_policy(iam.PolicyStatement(
            principals=[iam.ServicePrincipal("events.amazonaws.com")], actions=["sqs:SendMessage"],
            resources=[self.events_queue.queue_arn], conditions={"StringEquals": {"aws:SourceAccount": self.account}}))

        for label, q in (("EventsQueue", self.events_queue), ("RetryQueue", self.retry_queue), ("DeadLetterQueue", self.dead_letter)):
            CfnOutput(self, f"{label}Url", value=q.queue_url)

    def _bucket(self, name: str, expire_prefix: tuple[str, Duration] | None = None) -> s3.Bucket:
        return s3.Bucket(
            self, f"{name}Bucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,  # demo: `cdk destroy` borra datos también
            auto_delete_objects=True,
            lifecycle_rules=[s3.LifecycleRule(prefix=expire_prefix[0], expiration=expire_prefix[1])] if expire_prefix else None,
        )
