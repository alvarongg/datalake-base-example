#!/usr/bin/env python3
"""Punto de entrada de CDK. Orden de lectura recomendado para entender el sistema:

  WebStack      -> dónde vive la web (S3 + CloudFront)
  AuthStack     -> quién puede entrar (Cognito)
  DataLakeStack -> dónde viven los datos (buckets por capa + catálogo + Athena)
  PipelineStack -> cómo se transforman (Lambdas, Glue, Step Functions)
  ApiStack      -> cómo habla la web con todo lo anterior (API Gateway)
"""

import os

import aws_cdk as cdk

from stacks.api import ApiStack
from stacks.auth import AuthStack
from stacks.datalake import DataLakeStack
from stacks.pipeline import PipelineStack
from stacks.web import WebStack

PREFIX = "DatalakeDemo"

app = cdk.App()
env = cdk.Environment(
    account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
    region=os.environ.get("CDK_DEFAULT_REGION", "us-east-1"),
)

web = WebStack(app, f"{PREFIX}-Web", env=env)
auth = AuthStack(app, f"{PREFIX}-Auth", env=env)
lake = DataLakeStack(app, f"{PREFIX}-Lake", web_origin=web.origin, env=env)
pipeline = PipelineStack(app, f"{PREFIX}-Pipeline", lake=lake, env=env)
ApiStack(app, f"{PREFIX}-Api", lake=lake, pipeline=pipeline, auth=auth, web=web, env=env)

cdk.Tags.of(app).add("Project", "datalake-base-example")
app.synth()
