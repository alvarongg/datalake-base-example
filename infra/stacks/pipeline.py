"""Los pipelines, en DOS arquitecturas que se pueden comparar (el modo se elige en la web):

EVENT-DRIVEN (modo "event", por defecto)

   S3 PUT ─► SQS events ─► Lambda despachador ─► Bronze → Silver (pandas | Glue) → Gold
                ▲  ▲               │ condición no cumplida
   EventBridge ─┘  └── 20 s ── SQS retry-dlq            error / 15 intentos ─► SQS dead-letter
   (fin de Glue)

PROGRAMADA (modo "scheduled")

   EventBridge cada 30 min ─► Step Functions "scheduled":
        PlanProgramado ─► ¿hay trabajo? ─► datasets (Map en orden) ─► Gold (solo lo desactualizado)

Ambas reutilizan el MISMO código de cada capa (run_bronze, run_silver_pandas,
build_model, job de Glue): cambia solo el orquestador.

Cada permiso IAM se concede de forma explícita y mínima: ninguna función
puede tocar una capa que no necesita.
"""

from pathlib import Path

from aws_cdk import (
    ArnFormat,
    CfnOutput, Duration, RemovalPolicy, Stack,
    aws_events as events,
    aws_events_targets as targets,
    aws_lambda_event_sources as event_sources,
    aws_ssm as ssm,
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
GLUE_JOB_NAME = "datalake-demo-silver-facts"
MODE_PARAM = "/datalake-demo/pipeline-mode"
SCHEDULE_MINUTES = 30

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
        # Registro (id -> (función, memoria MB)) que usan Costos y Observabilidad para conocer cada componente.
        self.functions: dict[str, tuple[_lambda.Function, int]] = {}

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
            "PIPELINE_MODE_PARAM": MODE_PARAM,
        }
        # Modo de operación (event | scheduled). SSM Parameter Store estándar: sin costo.
        self.mode_param = ssm.StringParameter(
            self, "PipelineMode", parameter_name=MODE_PARAM, string_value="event",
            description="Modo del pipeline: event (event-driven) o scheduled (Step Functions programado)")
        self.pandas_layer = _lambda.LayerVersion.from_layer_version_arn(
            self, "PandasLayer",
            f"arn:aws:lambda:{self.region}:336392948345:layer:AWSSDKPandas-Python312:{PANDAS_LAYER_VERSION}",
        )

        plan_fn = self._function("Plan", "lambdas.plan.handler.lambda_handler", Duration.seconds(30), layer=False, memory=256)
        bronze_fn = self._function("Bronze", "lambdas.bronze.handler.lambda_handler", Duration.minutes(5))
        deps_fn = self._function("Dependencies", "lambdas.dependencies.handler.lambda_handler", Duration.seconds(30), layer=False, memory=256)
        silver_fn = self._function("SilverDimensions", "lambdas.silver_dimensions.handler.lambda_handler", Duration.minutes(5))
        finalize_fn = self._function("Finalize", "lambdas.finalize.handler.lambda_handler", Duration.seconds(30), layer=False, memory=256)
        gold_fn = self._function("Gold", "lambdas.gold.handler.lambda_handler", Duration.minutes(10))
        self.reset_fn = self._function("Reset", "lambdas.reset.handler.lambda_handler", Duration.minutes(2), layer=True)

        # ---- permisos mínimos por función ---------------------------------
        # Progreso y control viven en el bucket de resultados, SOLO bajo progress/ y control/.
        for fn in (plan_fn, bronze_fn, deps_fn, silver_fn, finalize_fn):
            lake.athena_results.grant_read_write(fn, "progress/*")
            lake.athena_results.grant_read_write(fn, "control/*")
        # Las Lambdas que calculan el estado del lake necesitan listar landing (versión de los archivos).
        for fn in (bronze_fn, deps_fn, gold_fn):
            lake.landing.grant_read(fn)

        lake.landing.grant_read_write(bronze_fn)  # mover a archive/ = copiar + borrar
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
        lake.athena_results.grant_read_write(glue_role, "progress/*")
        glue_role.add_to_policy(glue_policy(self, [lake.bronze_db], GLUE_READ_ACTIONS))
        glue_role.add_to_policy(glue_policy(self, [lake.silver_db], GLUE_ACTIONS))

        glue_job = glue.CfnJob(
            self, "SilverFactsJob",
            name=GLUE_JOB_NAME,
            role=glue_role.role_arn,
            glue_version="4.0",  # Spark 3.3 / Python 3
            worker_type="G.1X",
            number_of_workers=2,  # mínimo permitido: el volumen del ejemplo es chico
            timeout=15,           # minutos: evita que un error deje el job corriendo (y cobrando)
            max_retries=0,
            # sales y returns pueden procesarse al mismo tiempo (una ejecución por dataset).
            execution_property=glue.CfnJob.ExecutionPropertyProperty(max_concurrent_runs=2),
            command=glue.CfnJob.JobCommandProperty(
                name="glueetl", python_version="3", script_location=script.s3_object_url
            ),
            default_arguments={
                "--bronze_database": lake.bronze_db,
                "--silver_database": lake.silver_db,
                "--silver_path": f"s3://{lake.silver.bucket_name}/adventureworks",
                "--progress_bucket": lake.athena_results.bucket_name,
                "--dataset": "sales",           # Step Functions lo reemplaza por el dataset de la ejecución
                "--execution_id": "manual",     # ídem con el id de la ejecución
                "--enable-glue-datacatalog": "true",
                "--enable-metrics": "true",
                "--enable-continuous-cloudwatch-log": "true",
                "--job-bookmark-option": "job-bookmark-disable",  # reprocesa todo siempre (idempotente)
            },
        )

        # ---- Step Functions: pipeline de DATASETS ------------------------
        exec_id = sfn.JsonPath.string_at("$$.Execution.Id")  # asocia el progreso a ESTA corrida
        dataset = sfn.JsonPath.string_at("$.dataset")
        item_payload = sfn.TaskInput.from_object({"dataset": dataset, "executionId": exec_id})

        plan_step = tasks.LambdaInvoke(
            self, "Plan", lambda_function=plan_fn, payload_response_only=True,
            payload=sfn.TaskInput.from_object({"datasets": sfn.JsonPath.list_at("$.datasets"), "executionId": exec_id}),
            result_path=sfn.JsonPath.DISCARD,
        )
        bronze_step = tasks.LambdaInvoke(
            self, "Bronze", lambda_function=bronze_fn, payload_response_only=True,
            payload=item_payload, result_path="$.bronze", task_timeout=sfn.Timeout.duration(Duration.minutes(6)),
        )
        deps_step = tasks.LambdaInvoke(
            self, "CheckDependencies", lambda_function=deps_fn, payload_response_only=True,
            payload=item_payload, result_path="$.deps",
        )
        silver_pandas = tasks.LambdaInvoke(
            self, "SilverPandas", lambda_function=silver_fn, payload_response_only=True,
            payload=item_payload, result_path="$.silver", task_timeout=sfn.Timeout.duration(Duration.minutes(6)),
        )
        silver_glue = tasks.GlueStartJobRun(
            self, "SilverGlue", glue_job_name=glue_job.name,
            integration_pattern=sfn.IntegrationPattern.RUN_JOB,  # espera a que Glue termine
            arguments=sfn.TaskInput.from_object({"--dataset": dataset, "--execution_id": exec_id}),
            result_selector={"job_run_id.$": "$.Id", "state.$": "$.JobRunState", "seconds.$": "$.ExecutionTime"},
            result_path="$.silver",
            task_timeout=sfn.Timeout.duration(Duration.minutes(20)),
        )
        # Glue admite 2 corridas a la vez: si se supera, reintentar con backoff en vez de fallar.
        silver_glue.add_retry(errors=["Glue.ConcurrentRunsExceededException"], interval=Duration.seconds(30),
                              backoff_rate=2, max_attempts=4)
        record_step = tasks.LambdaInvoke(
            self, "RecordSilver", lambda_function=finalize_fn, payload_response_only=True,
            payload=sfn.TaskInput.from_object({
                "dataset": dataset, "executionId": exec_id,
                "built_from": sfn.JsonPath.object_at("$.deps.built_from"),
            }),
            result_path=sfn.JsonPath.DISCARD,
        )
        # Según el motor del dataset, Silver se procesa con Glue (Spark) o con pandas (Lambda).
        by_engine = (sfn.Choice(self, "EngineOfDataset")
                     .when(sfn.Condition.string_equals("$.engine", "glue"), silver_glue)
                     .otherwise(silver_pandas)
                     .afterwards())
        per_dataset = sfn.Chain.start(bronze_step).next(deps_step).next(by_engine).next(record_step)

        # Un dataset a la vez y en el orden recibido (ya viene ordenado por dependencias).
        for_each = sfn.Map(
            self, "ForEachDataset", items_path="$.datasets", max_concurrency=1,
            item_selector={"dataset": sfn.JsonPath.string_at("$$.Map.Item.Value.dataset"),
                           "engine": sfn.JsonPath.string_at("$$.Map.Item.Value.engine")},
            result_path=sfn.JsonPath.DISCARD,
        ).item_processor(per_dataset)

        self.dataset_logs = logs.LogGroup(self, "DatasetPipelineLogs", retention=logs.RetentionDays.ONE_WEEK,
                                          removal_policy=RemovalPolicy.DESTROY)
        self.gold_logs = logs.LogGroup(self, "GoldPipelineLogs", retention=logs.RetentionDays.ONE_WEEK,
                                       removal_policy=RemovalPolicy.DESTROY)
        self.dataset_machine = sfn.StateMachine(
            self, "DatasetPipeline",
            state_machine_name="datalake-demo-datasets",
            definition_body=sfn.DefinitionBody.from_chainable(plan_step.next(for_each)),
            timeout=Duration.hours(1),
            logs=sfn.LogOptions(destination=self.dataset_logs, level=sfn.LogLevel.ALL),
            tracing_enabled=True,  # X-Ray: ver cuánto tarda cada paso (capa gratuita: 100 mil trazas/mes)
        )

        # ---- Step Functions: pipeline GOLD -------------------------------
        gold_step = tasks.LambdaInvoke(
            self, "Gold", lambda_function=gold_fn, payload_response_only=True,
            # Se pasa el pedido completo: models, onlyStale, onlyReady.
            payload=sfn.TaskInput.from_object({"request": sfn.JsonPath.object_at("$"), "executionId": exec_id}),
            task_timeout=sfn.Timeout.duration(Duration.minutes(11)),
        )
        self.gold_machine = sfn.StateMachine(
            self, "GoldPipeline",
            state_machine_name="datalake-demo-gold",
            definition_body=sfn.DefinitionBody.from_chainable(gold_step),
            timeout=Duration.hours(1),
            logs=sfn.LogOptions(destination=self.gold_logs, level=sfn.LogLevel.ALL),
            tracing_enabled=True,
        )

        self._scheduled_flow(glue_job)
        self._event_driven(lake, glue_job)

        CfnOutput(self, "DatasetStateMachineArn", value=self.dataset_machine.state_machine_arn)
        CfnOutput(self, "GoldStateMachineArn", value=self.gold_machine.state_machine_arn)
        CfnOutput(self, "ResetFunctionName", value=self.reset_fn.function_name)

    # ------------------------------------------------------------------
    def _scheduled_flow(self, glue_job) -> None:
        """Arquitectura PROGRAMADA: EventBridge dispara cada 30 min un flujo que procesa todo lo nuevo."""
        lake = self.lake
        plan_fn = self._function("SchedulePlan", "lambdas.schedule_plan.handler.lambda_handler", Duration.seconds(30), layer=False, memory=256)
        lake.landing.grant_read(plan_fn)
        lake.athena_results.grant_read(plan_fn, "control/*")
        self.mode_param.grant_read(plan_fn)
        # ARN armado por nombre (no por referencia) para no crear un ciclo función ↔ máquina.
        scheduled_arn = self.format_arn(service="states", resource="stateMachine", resource_name="datalake-demo-scheduled",
                                        arn_format=ArnFormat.COLON_RESOURCE_NAME)
        plan_fn.add_environment("SCHEDULED_STATE_MACHINE_ARN", scheduled_arn)
        plan_fn.add_to_role_policy(iam.PolicyStatement(actions=["states:ListExecutions"], resources=[scheduled_arn]))

        plan = tasks.LambdaInvoke(self, "PlanProgramado", lambda_function=plan_fn, payload_response_only=True,
                                  payload=sfn.TaskInput.from_object({"manual": sfn.JsonPath.object_at("$.manual"),
                                                                     "executionId": sfn.JsonPath.string_at("$$.Execution.Id")}),
                                  result_path="$.plan", task_timeout=sfn.Timeout.duration(Duration.minutes(1)))
        # Flujos anidados (.sync:2): el padre espera al hijo y hereda su resultado. Cada hijo
        # se puede ejecutar y probar solo, y el padre queda simple.
        run_datasets = tasks.StepFunctionsStartExecution(
            self, "ProcesarDatasets", state_machine=self.dataset_machine,
            integration_pattern=sfn.IntegrationPattern.RUN_JOB,
            input=sfn.TaskInput.from_object({"datasets": sfn.JsonPath.list_at("$.plan.datasets")}),
            associate_with_parent=True, result_path=sfn.JsonPath.DISCARD)
        run_gold = tasks.StepFunctionsStartExecution(
            self, "ConstruirGold", state_machine=self.gold_machine,
            integration_pattern=sfn.IntegrationPattern.RUN_JOB,
            input=sfn.TaskInput.from_object({"models": [], "onlyStale": True, "onlyReady": True}),
            associate_with_parent=True, result_path=sfn.JsonPath.DISCARD)
        # Reintento con backoff exponencial si Step Functions está saturado (error transitorio).
        for t in (run_datasets, run_gold):
            t.add_retry(errors=["StepFunctions.ExecutionLimitExceeded", "StepFunctions.SdkClientException"],
                        interval=Duration.seconds(5), backoff_rate=2, max_attempts=3)
        failed = sfn.Fail(self, "FalloProgramado", error="PipelineFailed",
                          cause="Falló un paso del lote programado: revisa la ejecución hija")
        run_datasets.add_catch(failed, errors=["States.ALL"], result_path="$.error")
        run_gold.add_catch(failed, errors=["States.ALL"], result_path="$.error")

        gold_or_done = (sfn.Choice(self, "HayGoldPendiente")
                        .when(sfn.Condition.boolean_equals("$.plan.goldWork", True), run_gold)
                        .otherwise(sfn.Succeed(self, "TodoAlDia", comment="Nada nuevo que procesar")))
        definition = plan.next(
            sfn.Choice(self, "ModoProgramado")
            .when(sfn.Condition.boolean_equals("$.plan.skip", True),
                  sfn.Succeed(self, "ModoEventDriven", comment="El modo event-driven está activo: no se hace nada"))
            .when(sfn.Condition.boolean_equals("$.plan.hasDatasets", True), run_datasets.next(gold_or_done))
            .otherwise(gold_or_done))

        self.scheduled_logs = logs.LogGroup(self, "ScheduledPipelineLogs", retention=logs.RetentionDays.ONE_WEEK,
                                            removal_policy=RemovalPolicy.DESTROY)
        self.scheduled_machine = sfn.StateMachine(
            self, "ScheduledPipeline", state_machine_name="datalake-demo-scheduled",
            definition_body=sfn.DefinitionBody.from_chainable(definition), timeout=Duration.hours(2),
            logs=sfn.LogOptions(destination=self.scheduled_logs, level=sfn.LogLevel.ALL), tracing_enabled=True)

        # Disparador programado. Siempre activo: si el modo es event-driven, el flujo termina al instante
        # (así un redeploy de CDK nunca deja la regla en un estado distinto al del modo).
        events.Rule(self, "ScheduleRule", rule_name="datalake-demo-schedule",
                    description=f"Ejecuta el pipeline programado cada {SCHEDULE_MINUTES} minutos",
                    schedule=events.Schedule.rate(Duration.minutes(SCHEDULE_MINUTES)),
                    targets=[targets.SfnStateMachine(self.scheduled_machine,
                                                     input=events.RuleTargetInput.from_object({"manual": False}))])
        CfnOutput(self, "ScheduledStateMachineArn", value=self.scheduled_machine.state_machine_arn)

    def _event_driven(self, lake, glue_job) -> None:
        """Arquitectura EVENT-DRIVEN: SQS → Lambda despachador → siguiente paso."""
        fn = self._function("Dispatcher", "lambdas.dispatcher.handler.lambda_handler", Duration.minutes(2))
        fn.add_environment("EVENTS_QUEUE_URL", lake.events_queue.queue_url)
        fn.add_environment("RETRY_QUEUE_URL", lake.retry_queue.queue_url)
        fn.add_environment("DLQ_URL", lake.dead_letter.queue_url)
        fn.add_environment("GLUE_JOB_NAME", GLUE_JOB_NAME)

        # Hace lo mismo que Bronze + Silver + Gold, así que necesita la suma de sus permisos (y nada más).
        for bucket in (lake.landing, lake.bronze, lake.silver, lake.gold, lake.athena_results):
            bucket.grant_read_write(fn)
        fn.add_to_role_policy(glue_policy(self, [lake.bronze_db, lake.silver_db, lake.gold_db], GLUE_ACTIONS))
        fn.add_to_role_policy(athena_policy(self, lake.workgroup))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["glue:StartJobRun", "glue:GetJobRun"],
            resources=[self.format_arn(service="glue", resource="job", resource_name=GLUE_JOB_NAME)]))
        for q in (lake.events_queue, lake.retry_queue, lake.dead_letter):
            q.grant_send_messages(fn)
        self.mode_param.grant_read(fn)

        # Dos colas, la misma Lambda. batch_size=1: cada mensaje es una decisión (más fácil de seguir en los logs).
        # report_batch_item_failures: si falla un mensaje, solo ese vuelve a la cola.
        # max_concurrency=2: tope de Lambdas en paralelo por cola (protege a Athena y al costo).
        for q in (lake.events_queue, lake.retry_queue):
            fn.add_event_source(event_sources.SqsEventSource(q, batch_size=1, report_batch_item_failures=True, max_concurrency=2))

        # Fin de un job de Glue -> EventBridge -> cola events (L1 para no crear dependencias circulares entre stacks).
        events.CfnRule(self, "GlueStateChangeRule", name="datalake-demo-glue-finished",
                       description="Avisa al despachador cuando termina un job de Silver en Glue",
                       event_pattern={"source": ["aws.glue"], "detail-type": ["Glue Job State Change"],
                                      "detail": {"jobName": [GLUE_JOB_NAME], "state": ["SUCCEEDED", "FAILED", "TIMEOUT", "STOPPED", "ERROR"]}},
                       targets=[events.CfnRule.TargetProperty(id="events-queue", arn=lake.events_queue.queue_arn)])
        self.dispatcher_fn = fn

    def _function(self, name: str, handler: str, timeout: Duration, layer: bool = True, memory: int = 1024) -> _lambda.Function:
        fn = _lambda.Function(
            self, f"{name}Function",
            runtime=_lambda.Runtime.PYTHON_3_12,
            handler=handler,
            code=backend_code(),
            layers=[self.pandas_layer] if layer else [],
            memory_size=memory,
            timeout=timeout,
            environment=self.env_vars,
            log_retention=logs.RetentionDays.ONE_WEEK,
        )
        self.functions[name] = (fn, memory)
        return fn
