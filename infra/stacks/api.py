"""API HTTP protegida por Cognito (JWT) que usa la web.

Tres funciones con permisos distintos (mínimo privilegio):
  * API            -> estado, subida, pipelines, reset y consultas
  * Costos         -> SOLO lee métricas/historiales para estimar el gasto
  * Observabilidad -> SOLO lee logs y ejecuciones
"""

from aws_cdk import (ArnFormat, CfnOutput, Duration, Stack, aws_apigatewayv2 as apigw, aws_iam as iam,
                     aws_lambda as _lambda, aws_logs as logs)
from aws_cdk.aws_apigatewayv2_authorizers import HttpJwtAuthorizer
from aws_cdk.aws_apigatewayv2_integrations import HttpLambdaIntegration
from constructs import Construct

from stacks.auth import AuthStack
from stacks.datalake import DataLakeStack
from stacks.pipeline import (GLUE_JOB_NAME, SCHEDULE_MINUTES, PipelineStack, backend_code, athena_policy, glue_policy,
                             GLUE_READ_ACTIONS)
from stacks.web import WebStack

# Cómo se llama cada Lambda del pipeline en la web: clave del registro -> (id, etiqueta, etapa)
COMPONENTS = {
    "Plan": ("plan", "Plan · cola de datasets", "plan"),
    "Bronze": ("bronze", "Bronze · ingesta (Lambda)", "bronze"),
    "Dependencies": ("dependencies", "Compuerta de dependencias", "dependencies"),
    "SilverDimensions": ("silver_pandas", "Silver · pandas (Lambda)", "silver"),
    "Finalize": ("finalize", "Registro de Silver", "silver"),
    "Gold": ("gold", "Gold · Athena CTAS (Lambda)", "gold"),
    "Reset": ("reset", "Reset del lake", "reset"),
    "Dispatcher": ("dispatcher", "Despachador event-driven (Lambda)", "event"),
    "SchedulePlan": ("schedule_plan", "Plan programado (Lambda)", "orchestration"),
}
GLUE_LOG_GROUPS = ["/aws-glue/jobs/output", "/aws-glue/jobs/error", "/aws-glue/jobs/logs-v2"]


class ApiStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, lake: DataLakeStack, pipeline: PipelineStack,
                 auth: AuthStack, web: WebStack, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        fn = _lambda.Function(
            self, "ApiFunction",
            runtime=_lambda.Runtime.PYTHON_3_12,
            handler="lambdas.api.handler.lambda_handler",
            code=backend_code(),
            memory_size=256,
            timeout=Duration.seconds(28),  # API Gateway corta a los 29 s
            environment={
                **pipeline.env_vars,
                "DATASET_STATE_MACHINE_ARN": pipeline.dataset_machine.state_machine_arn,
                "GOLD_STATE_MACHINE_ARN": pipeline.gold_machine.state_machine_arn,
                "RESET_FUNCTION_NAME": pipeline.reset_fn.function_name,
                "SCHEDULED_STATE_MACHINE_ARN": pipeline.scheduled_machine.state_machine_arn,
                "EVENTS_QUEUE_URL": lake.events_queue.queue_url,
                "RETRY_QUEUE_URL": lake.retry_queue.queue_url,
                "DLQ_URL": lake.dead_letter.queue_url,
                "SCHEDULE_MINUTES": str(SCHEDULE_MINUTES),
            },
            log_retention=logs.RetentionDays.ONE_WEEK,
        )

        # ---- permisos mínimos de la API ----------------------------------
        lake.landing.grant_read_write(fn)  # firmar URLs de subida y reponer desde archive/
        # Consultas ad-hoc: puede LEER las tres capas, nunca escribirlas.
        for bucket in (lake.bronze, lake.silver, lake.gold):
            bucket.grant_read(fn)
        lake.athena_results.grant_read_write(fn)
        fn.add_to_role_policy(
            glue_policy(self, [lake.bronze_db, lake.silver_db, lake.gold_db], GLUE_READ_ACTIONS)
        )
        fn.add_to_role_policy(athena_policy(self, lake.workgroup))
        machines = (pipeline.dataset_machine, pipeline.gold_machine, pipeline.scheduled_machine)
        for machine in machines:
            machine.grant_start_execution(fn)
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["states:ListExecutions"],
            resources=[m.state_machine_arn for m in machines],
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["states:DescribeExecution", "states:GetExecutionHistory"],
            resources=self._execution_arns(machines),
        ))
        pipeline.reset_fn.grant_invoke(fn)
        # Modo de operación: leer y cambiar.
        pipeline.mode_param.grant_read(fn)
        pipeline.mode_param.grant_write(fn)
        # Colas: ver su profundidad, re-emitir eventos y hacer redrive de la DLQ final.
        for q in (lake.events_queue, lake.retry_queue, lake.dead_letter):
            fn.add_to_role_policy(iam.PolicyStatement(actions=["sqs:GetQueueAttributes"], resources=[q.queue_arn]))
        lake.events_queue.grant_send_messages(fn)
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["sqs:StartMessageMoveTask", "sqs:ReceiveMessage", "sqs:DeleteMessage"], resources=[lake.dead_letter.queue_arn]))

        # ---- API Gateway + autorizador JWT -------------------------------
        authorizer = HttpJwtAuthorizer(
            "CognitoAuthorizer",
            jwt_issuer=f"https://cognito-idp.{self.region}.amazonaws.com/{auth.user_pool.user_pool_id}",
            jwt_audience=[auth.client.user_pool_client_id],
        )
        api = apigw.HttpApi(
            self, "HttpApi",
            default_authorizer=authorizer,
            cors_preflight=apigw.CorsPreflightOptions(
                allow_origins=[web.origin, "http://localhost:5173"],
                allow_methods=[apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
                allow_headers=["authorization", "content-type"],
                max_age=Duration.days(1),
            ),
        )

        # ---- Costos y Observabilidad (funciones de solo lectura) ----------
        costs_fn, obs_fn = self._read_only_functions(lake, pipeline, web, api, fn, machines)

        api_integration = HttpLambdaIntegration("RoutesIntegration", fn)
        for method, path in (
            (apigw.HttpMethod.GET, "/state"),
            (apigw.HttpMethod.GET, "/events"),
            (apigw.HttpMethod.GET, "/storage"),
            (apigw.HttpMethod.POST, "/mode"),
            (apigw.HttpMethod.POST, "/landing/restore"),
            (apigw.HttpMethod.POST, "/events/simulate"),
            (apigw.HttpMethod.POST, "/dlq/redrive"),
            (apigw.HttpMethod.POST, "/schedule/run"),
            (apigw.HttpMethod.POST, "/upload-url"),
            (apigw.HttpMethod.POST, "/pipeline/start"),
            (apigw.HttpMethod.POST, "/reset"),
            (apigw.HttpMethod.POST, "/query"),
        ):
            api.add_routes(path=path, methods=[method], integration=api_integration)
        api.add_routes(path="/costs", methods=[apigw.HttpMethod.GET], integration=HttpLambdaIntegration("CostsIntegration", costs_fn))
        obs_integration = HttpLambdaIntegration("ObservabilityIntegration", obs_fn)
        for path in ("/logs", "/runs"):
            api.add_routes(path=path, methods=[apigw.HttpMethod.GET], integration=obs_integration)

        # Límite de peticiones: protege el costo ante abuso.
        stage = api.default_stage.node.default_child
        stage.default_route_settings = apigw.CfnStage.RouteSettingsProperty(
            throttling_burst_limit=20, throttling_rate_limit=10
        )

        CfnOutput(self, "ApiUrl", value=api.api_endpoint)

    # ------------------------------------------------------------------
    def _execution_arns(self, machines) -> list[str]:
        return [self.format_arn(service="states", resource="execution", resource_name=f"{m.state_machine_name}:*",
                                arn_format=ArnFormat.COLON_RESOURCE_NAME) for m in machines]

    def _log_group_arn(self, name: str) -> str:
        return self.format_arn(service="logs", resource="log-group", resource_name=f"{name}:*",
                               arn_format=ArnFormat.COLON_RESOURCE_NAME)

    def _read_only_functions(self, lake, pipeline, web, api, api_fn, machines):
        def make(name: str, handler: str, env: dict, memory: int):
            return _lambda.Function(
                self, name, runtime=_lambda.Runtime.PYTHON_3_12, handler=handler, code=backend_code(),
                memory_size=memory, timeout=Duration.seconds(28), environment=env,
                log_retention=logs.RetentionDays.ONE_WEEK,
            )

        # Componentes conocidos: Lambdas del pipeline + la API + los flujos de Step Functions + Glue.
        lambda_groups = {key: f"/aws/lambda/{f.function_name}" for key, (f, _m) in pipeline.functions.items()}
        lambda_groups["Api"] = f"/aws/lambda/{api_fn.function_name}"
        sfn_groups = {"datasets": pipeline.dataset_logs.log_group_name, "gold": pipeline.gold_logs.log_group_name,
                      "scheduled": pipeline.scheduled_logs.log_group_name}

        sources = {"api": {"label": "API (Lambda)", "kind": "lambda", "stage": "api", "groups": [lambda_groups["Api"]]}}
        for key, (cid, label, stage) in COMPONENTS.items():
            sources[cid] = {"label": label, "kind": "lambda", "stage": stage, "groups": [lambda_groups[key]]}
        sources["sfn_datasets"] = {"label": "Step Functions · datasets", "kind": "sfn", "stage": "orchestration", "groups": [sfn_groups["datasets"]]}
        sources["sfn_gold"] = {"label": "Step Functions · Gold", "kind": "sfn", "stage": "orchestration", "groups": [sfn_groups["gold"]]}
        sources["sfn_scheduled"] = {"label": "Step Functions · programado", "kind": "sfn", "stage": "orchestration", "groups": [sfn_groups["scheduled"]]}
        sources["glue"] = {"label": "AWS Glue · Spark (silver ventas/devoluciones)", "kind": "glue", "stage": "silver", "groups": GLUE_LOG_GROUPS}

        machine_arns = {"datasets": pipeline.dataset_machine.state_machine_arn, "gold": pipeline.gold_machine.state_machine_arn,
                        "scheduled": pipeline.scheduled_machine.state_machine_arn}
        all_groups = [g for s in sources.values() for g in s["groups"] if not g.startswith("/aws-glue")]

        # --- Costos
        lambdas = {key: {"name": f.function_name, "memory": mem, "label": COMPONENTS.get(key, (None, key))[1]}
                   for key, (f, mem) in pipeline.functions.items()}
        lambdas["Api"] = {"name": api_fn.function_name, "memory": 256, "label": "API (Lambda)"}
        cost_config = self.to_json_string({
            "lambdas": lambdas, "glueJob": GLUE_JOB_NAME, "workgroup": lake.workgroup, "machines": machine_arns,
            "buckets": {"landing": lake.landing.bucket_name, "bronze": lake.bronze.bucket_name,
                        "silver": lake.silver.bucket_name, "gold": lake.gold.bucket_name,
                        "athena-results": lake.athena_results.bucket_name, "web": web.bucket.bucket_name},
            "apiId": api.api_id, "distributionId": web.distribution.distribution_id, "logGroups": all_groups,
            "queues": {"events": lake.events_queue.queue_name, "retry": lake.retry_queue.queue_name, "dlq": lake.dead_letter.queue_name},
        })
        costs_fn = make("CostsFunction", "lambdas.costs.handler.lambda_handler", {"COST_CONFIG": cost_config}, 512)
        costs_fn.add_to_role_policy(iam.PolicyStatement(actions=["cloudwatch:GetMetricData"], resources=["*"]))
        costs_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["athena:ListQueryExecutions", "athena:BatchGetQueryExecution"],
            resources=[self.format_arn(service="athena", resource="workgroup", resource_name=lake.workgroup)]))
        costs_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["glue:GetJobRuns"],
            resources=[self.format_arn(service="glue", resource="job", resource_name=GLUE_JOB_NAME)]))
        costs_fn.add_to_role_policy(iam.PolicyStatement(actions=["states:ListExecutions"], resources=list(m.state_machine_arn for m in machines)))
        costs_fn.add_to_role_policy(iam.PolicyStatement(actions=["states:GetExecutionHistory"], resources=self._execution_arns(machines)))
        costs_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["s3:ListBucket"],
            resources=[b.bucket_arn for b in (lake.landing, lake.bronze, lake.silver, lake.gold, lake.athena_results, web.bucket)]))

        # --- Observabilidad
        obs_fn = make("ObservabilityFunction", "lambdas.observability.handler.lambda_handler", {
            "LOG_SOURCES": self.to_json_string(sources), "STATE_MACHINES": self.to_json_string(machine_arns), "GLUE_JOB": GLUE_JOB_NAME,
        }, 512)
        obs_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["logs:FilterLogEvents"],
            resources=[self._log_group_arn(g) for g in all_groups + GLUE_LOG_GROUPS]))
        obs_fn.add_to_role_policy(iam.PolicyStatement(actions=["states:ListExecutions"], resources=list(m.state_machine_arn for m in machines)))
        obs_fn.add_to_role_policy(iam.PolicyStatement(actions=["states:DescribeExecution", "states:GetExecutionHistory"], resources=self._execution_arns(machines)))
        obs_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["glue:GetJobRuns"],
            resources=[self.format_arn(service="glue", resource="job", resource_name=GLUE_JOB_NAME)]))
        return costs_fn, obs_fn
