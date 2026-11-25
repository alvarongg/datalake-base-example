"""Tests de infraestructura: sintetiza los stacks y comprueba las reglas de seguridad clave."""

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

from stacks.api import ApiStack
from stacks.auth import AuthStack
from stacks.datalake import DataLakeStack
from stacks.pipeline import PipelineStack
from stacks.web import WebStack


@pytest.fixture(scope="module")
def stacks():
    app = cdk.App()
    env = cdk.Environment(account="111111111111", region="us-east-1")
    web = WebStack(app, "Web", env=env)
    auth = AuthStack(app, "Auth", env=env)
    lake = DataLakeStack(app, "Lake", web_origin=web.origin, env=env)
    pipe = PipelineStack(app, "Pipe", lake=lake, env=env)
    api = ApiStack(app, "Api", lake=lake, pipeline=pipe, auth=auth, web=web, env=env)
    return {"web": web, "auth": auth, "lake": lake, "pipe": pipe, "api": api}


def test_all_buckets_are_private_and_encrypted(stacks):
    for key in ("web", "lake"):
        t = Template.from_stack(stacks[key])
        for _, res in t.find_resources("AWS::S3::Bucket").items():
            props = res["Properties"]
            assert props["PublicAccessBlockConfiguration"]["BlockPublicAcls"] is True
            assert "BucketEncryption" in props


def test_cognito_has_no_self_signup(stacks):
    t = Template.from_stack(stacks["auth"])
    t.has_resource_properties("AWS::Cognito::UserPool",
                              {"AdminCreateUserConfig": {"AllowAdminCreateUserOnly": True}})


def test_glue_job_is_small_and_has_timeout(stacks):
    t = Template.from_stack(stacks["pipe"])
    t.has_resource_properties("AWS::Glue::Job", {"NumberOfWorkers": 2, "Timeout": 15, "MaxRetries": 0})


def test_state_machine_exists(stacks):
    Template.from_stack(stacks["pipe"]).resource_count_is("AWS::StepFunctions::StateMachine", 3)


def test_every_api_route_requires_jwt(stacks):
    t = Template.from_stack(stacks["api"])
    routes = t.find_resources("AWS::ApiGatewayV2::Route")
    assert len(routes) == 16
    for r in routes.values():
        assert r["Properties"]["AuthorizationType"] == "JWT"
