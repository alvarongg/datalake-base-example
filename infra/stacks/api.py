"""API HTTP protegida por Cognito (JWT) que usa la web."""

from aws_cdk import (ArnFormat, CfnOutput, Duration, Stack, aws_apigatewayv2 as apigw, aws_iam as iam,
                     aws_lambda as _lambda, aws_logs as logs)
from aws_cdk.aws_apigatewayv2_authorizers import HttpJwtAuthorizer
from aws_cdk.aws_apigatewayv2_integrations import HttpLambdaIntegration
from constructs import Construct

from stacks.auth import AuthStack
from stacks.datalake import DataLakeStack
from stacks.pipeline import PipelineStack, backend_code, athena_policy, glue_policy, GLUE_READ_ACTIONS
from stacks.web import WebStack


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
                "STATE_MACHINE_ARN": pipeline.state_machine.state_machine_arn,
                "RESET_FUNCTION_NAME": pipeline.reset_fn.function_name,
            },
            log_retention=logs.RetentionDays.ONE_WEEK,
        )

        # ---- permisos mínimos --------------------------------------------
        lake.landing.grant_read(fn)
        lake.landing.grant_put(fn)  # necesario para firmar URLs de subida
        # Consultas ad-hoc: puede LEER las tres capas, nunca escribirlas.
        for bucket in (lake.bronze, lake.silver, lake.gold):
            bucket.grant_read(fn)
        lake.athena_results.grant_read_write(fn)
        fn.add_to_role_policy(
            glue_policy(self, [lake.bronze_db, lake.silver_db, lake.gold_db], GLUE_READ_ACTIONS)
        )
        fn.add_to_role_policy(athena_policy(self, lake.workgroup))
        pipeline.state_machine.grant_start_execution(fn)
        pipeline.state_machine.grant_read(fn)
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["states:ListExecutions", "states:DescribeExecution", "states:GetExecutionHistory"],
            resources=[
                pipeline.state_machine.state_machine_arn,
                self.format_arn(service="states", resource="execution",
                                resource_name=f"{pipeline.state_machine.state_machine_name}:*",
                                arn_format=ArnFormat.COLON_RESOURCE_NAME),
            ],
        ))
        pipeline.reset_fn.grant_invoke(fn)

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
        integration = HttpLambdaIntegration("RoutesIntegration", fn)
        for method, path in (
            (apigw.HttpMethod.GET, "/files"),
            (apigw.HttpMethod.POST, "/upload-url"),
            (apigw.HttpMethod.POST, "/pipeline/start"),
            (apigw.HttpMethod.GET, "/pipeline/status"),
            (apigw.HttpMethod.POST, "/reset"),
            (apigw.HttpMethod.POST, "/query"),
        ):
            api.add_routes(path=path, methods=[method], integration=integration)

        # Límite de peticiones: protege el costo ante abuso.
        stage = api.default_stage.node.default_child
        stage.default_route_settings = apigw.CfnStage.RouteSettingsProperty(
            throttling_burst_limit=20, throttling_rate_limit=10
        )

        CfnOutput(self, "ApiUrl", value=api.api_endpoint)
