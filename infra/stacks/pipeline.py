"""El pipeline medallion: Lambdas + Glue Job + Step Functions.

        ┌────────┐   ┌─────────────────────────────────┐   ┌──────┐
 CSV -> │ BRONZE │ → │ SILVER (en paralelo)            │ → │ GOLD │
        │ Lambda │   │  · dimensiones: Lambda (pandas) │   │Lambda│
        │ (wr)   │   │  · hechos: Glue Job (Spark)     │   │(CTAS)│
        └────────┘   └─────────────────────────────────┘   └──────┘

Cada permiso IAM se concede de forma explícita y mínima: ninguna función
puede tocar una capa que no necesita.
"""

from pathlib import Path

from aws_cdk import (
    CfnOutput, Duration, RemovalPolicy, Stack,
    aws_glue as glue,
    aws_iam as iam,
    aws_lambda as _lambda,
    aws_logs as logs,
    aws_s3_assets as s3_assets,
    aws_stepfunctions as sfn,
    aws_stepfunctions_tasks as tasks,
)
from constructs import Construct

from stacks.datalake import DataLakeStack

BACKEND_DIR = str(Path(__file__).resolve().parents[2] / "backend")
GLUE_SCRIPT = str(Path(BACKEND_DIR) / "glue" / "silver_facts.py")

# Capa gestionada de AWS con pandas + awswrangler ya instalados (evita empaquetar
# dependencias pesadas). Versiones: https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html
PANDAS_LAYER_VERSION = 32

GLUE_ACTIONS = [
    "glue:GetDatabase", "glue:GetDatabases", "glue:GetTable", "glue:GetTables",
    "glue:CreateTable", "glue:UpdateTable", "glue:DeleteTable",
    "glue:GetPartition", "glue:GetPartitions", "glue:BatchGetPartition",
    "glue:CreatePartition", "glue:BatchCreatePartition", "glue:UpdatePartition",
    "glue:DeletePartition", "glue:BatchDeletePartition",
]
GLUE_READ_ACTIONS = [a for a in GLUE_ACTIONS if a.split(":")[1].startswith("Get")]
ATHENA_ACTIONS = [
    "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults",
    "athena:StopQueryExecution", "athena:GetWorkGroup",
]


def backend_code() -> _lambda.Code:
    """Todo el directorio backend/ viaja con cada Lambda (incluye common/ y sql/).

    Hay que crear una instancia NUEVA por stack: CDK no permite compartirla.
    """
    return _lambda.Code.from_asset(BACKEND_DIR, exclude=["glue", "**/__pycache__", "*.pyc"])


def glue_policy(stack: Stack, dbs: list[str], actions: list[str]) -> iam.PolicyStatement:
    """Permisos de Glue Catalog limitados a bases de datos concretas."""
    resources = [stack.format_arn(service="glue", resource="catalog")]
    for db in dbs:
        resources += [
            stack.format_arn(service="glue", resource="database", resource_name=db),
            stack.format_arn(service="glue", resource="table", resource_name=f"{db}/*"),
        ]
    return iam.PolicyStatement(actions=actions, resources=resources)


def athena_policy(stack: Stack, workgroup: str) -> iam.PolicyStatement:
    return iam.PolicyStatement(
        actions=ATHENA_ACTIONS,
        resources=[stack.format_arn(service="athena", resource="workgroup", resource_name=workgroup)],
    )


class PipelineStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, lake: DataLakeStack, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        self.lake = lake

        # Variables de entorno comunes: lo único que el código necesita saber del entorno.
        self.env_vars = {
            "LANDING_BUCKET": lake.landing.bucket_name,
            "BRONZE_BUCKET": lake.bronze.bucket_name,
            "SILVER_BUCKET": lake.silver.bucket_name,
            "GOLD_BUCKET": lake.gold.bucket_name,
            "ATHENA_RESULTS_BUCKET": lake.athena_results.bucket_name,
            "BRONZE_DB": lake.bronze_db,
            "SILVER_DB": lake.silver_db,
            "GOLD_DB": lake.gold_db,
            "ATHENA_WORKGROUP": lake.workgroup,
        }
        self.pandas_layer = _lambda.LayerVersion.from_layer_version_arn(
            self, "PandasLayer",
            f"arn:aws:lambda:{self.region}:336392948345:layer:AWSSDKPandas-Python312:{PANDAS_LAYER_VERSION}",
        )

        bronze_fn = self._function("Bronze", "lambdas.bronze.handler.lambda_handler", Duration.minutes(5))
        silver_fn = self._function("SilverDimensions", "lambdas.silver_dimensions.handler.lambda_handler", Duration.minutes(5))
        gold_fn = self._function("Gold", "lambdas.gold.handler.lambda_handler", Duration.minutes(10))
        self.reset_fn = self._function("Reset", "lambdas.reset.handler.lambda_handler", Duration.minutes(2), layer=True)

        # ---- permisos mínimos por función ---------------------------------
        lake.landing.grant_read(bronze_fn)
        lake.bronze.grant_read_write(bronze_fn)
        bronze_fn.add_to_role_policy(glue_policy(self, [lake.bronze_db], GLUE_ACTIONS))

        lake.bronze.grant_read(silver_fn)
        lake.silver.grant_read_write(silver_fn)
        silver_fn.add_to_role_policy(glue_policy(self, [lake.silver_db], GLUE_ACTIONS))

        lake.silver.grant_read(gold_fn)
        lake.gold.grant_read_write(gold_fn)
        lake.athena_results.grant_read_write(gold_fn)
        gold_fn.add_to_role_policy(glue_policy(self, [lake.gold_db], GLUE_ACTIONS))
        gold_fn.add_to_role_policy(glue_policy(self, [lake.silver_db], GLUE_READ_ACTIONS))
        gold_fn.add_to_role_policy(athena_policy(self, lake.workgroup))

        # Reset: único con permiso de borrado masivo (y solo sobre el lake).
        for bucket in (lake.landing, lake.bronze, lake.silver, lake.gold, lake.athena_results):
            bucket.grant_read_write(self.reset_fn)
        self.reset_fn.add_to_role_policy(
            glue_policy(self, [lake.bronze_db, lake.silver_db, lake.gold_db], GLUE_ACTIONS)
        )

        # ---- Glue job (Spark) para las tablas de hechos -------------------
        script = s3_assets.Asset(self, "GlueScript", path=GLUE_SCRIPT)
        glue_role = iam.Role(
            self, "GlueRole",
            assumed_by=iam.ServicePrincipal("glue.amazonaws.com"),
            managed_policies=[iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSGlueServiceRole")],
        )
        script.grant_read(glue_role)
        lake.bronze.grant_read(glue_role)
        lake.silver.grant_read_write(glue_role)
        glue_role.add_to_policy(glue_policy(self, [lake.bronze_db], GLUE_READ_ACTIONS))
        glue_role.add_to_policy(glue_policy(self, [lake.silver_db], GLUE_ACTIONS))

        glue_job = glue.CfnJob(
            self, "SilverFactsJob",
            name="datalake-demo-silver-facts",
            role=glue_role.role_arn,
            glue_version="4.0",  # Spark 3.3 / Python 3
            worker_type="G.1X",
            number_of_workers=2,  # mínimo permitido: el volumen del ejemplo es chico
            timeout=15,           # minutos: evita que un error deje el job corriendo (y cobrando)
            max_retries=0,
            command=glue.CfnJob.JobCommandProperty(
                name="glueetl", python_version="3", script_location=script.s3_object_url
            ),
            default_arguments={
                "--bronze_database": lake.bronze_db,
                "--silver_database": lake.silver_db,
                "--silver_path": f"s3://{lake.silver.bucket_name}/adventureworks",
                "--enable-glue-datacatalog": "true",
                "--enable-metrics": "true",
                "--enable-continuous-cloudwatch-log": "true",
                "--job-bookmark-option": "job-bookmark-disable",  # reprocesa todo siempre (idempotente)
            },
        )

        # ---- Step Functions ----------------------------------------------
        bronze_step = tasks.LambdaInvoke(
            self, "Bronze", lambda_function=bronze_fn, payload_response_only=True,
            result_path="$.bronze",
        )
        silver_dims = tasks.LambdaInvoke(
            self, "SilverDimensions", lambda_function=silver_fn, payload_response_only=True,
            result_path="$.silver_dimensions",
        )
        silver_facts = tasks.GlueStartJobRun(
            self, "SilverFacts", glue_job_name=glue_job.name,
            integration_pattern=sfn.IntegrationPattern.RUN_JOB,  # espera a que Glue termine
            result_selector={"job_run_id.$": "$.Id", "state.$": "$.JobRunState",
                             "seconds.$": "$.ExecutionTime"},
            result_path="$.silver_facts",
        )
        gold_step = tasks.LambdaInvoke(
            self, "Gold", lambda_function=gold_fn, payload_response_only=True,
            result_path="$.gold",
        )
        silver_parallel = sfn.Parallel(self, "Silver", result_path="$.silver").branch(silver_dims).branch(silver_facts)
        # Cada rama escribe en su propio result_path; Parallel devuelve un array.
        # Lo dejamos en $.silver y descartamos la entrada duplicada.

        definition = bronze_step.next(silver_parallel).next(gold_step)

        self.state_machine = sfn.StateMachine(
            self, "Pipeline",
            state_machine_name="datalake-demo-medallion",
            definition_body=sfn.DefinitionBody.from_chainable(definition),
            timeout=Duration.hours(1),
            logs=sfn.LogOptions(
                destination=logs.LogGroup(self, "PipelineLogs", retention=logs.RetentionDays.ONE_WEEK,
                                          removal_policy=RemovalPolicy.DESTROY),
                level=sfn.LogLevel.ERROR,
            ),
        )

        CfnOutput(self, "StateMachineArn", value=self.state_machine.state_machine_arn)
        CfnOutput(self, "ResetFunctionName", value=self.reset_fn.function_name)

    def _function(self, name: str, handler: str, timeout: Duration, layer: bool = True) -> _lambda.Function:
        return _lambda.Function(
            self, f"{name}Function",
            runtime=_lambda.Runtime.PYTHON_3_12,
            handler=handler,
            code=backend_code(),
            layers=[self.pandas_layer] if layer else [],
            memory_size=1024,
            timeout=timeout,
            environment=self.env_vars,
            log_retention=logs.RetentionDays.ONE_WEEK,
        )
