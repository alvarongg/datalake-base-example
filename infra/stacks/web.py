"""Hosting de la web: bucket S3 PRIVADO + CloudFront.

El bucket no es público: solo CloudFront puede leerlo (Origin Access Control).
Así todo el tráfico pasa por HTTPS y por las cabeceras de seguridad de CloudFront.
El contenido (la web compilada) lo sube deplo.sh, no CDK, porque la web
necesita conocer las salidas de los otros stacks (URL de API, IDs de Cognito).
"""

from aws_cdk import CfnOutput, RemovalPolicy, Stack, aws_cloudfront as cf, aws_cloudfront_origins as origins, aws_s3 as s3
from constructs import Construct


class WebStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        self.bucket = s3.Bucket(
            self, "WebBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,  # demo: `cdk destroy` limpia todo
            auto_delete_objects=True,
        )

        self.distribution = cf.Distribution(
            self, "Distribution",
            default_root_object="index.html",
            price_class=cf.PriceClass.PRICE_CLASS_100,  # solo las ubicaciones más baratas
            minimum_protocol_version=cf.SecurityPolicyProtocol.TLS_V1_2_2021,
            default_behavior=cf.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(self.bucket),
                viewer_protocol_policy=cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                response_headers_policy=cf.ResponseHeadersPolicy.SECURITY_HEADERS,
                compress=True,
            ),
            # SPA: cualquier ruta desconocida devuelve index.html.
            error_responses=[
                cf.ErrorResponse(http_status=403, response_http_status=200, response_page_path="/index.html"),
                cf.ErrorResponse(http_status=404, response_http_status=200, response_page_path="/index.html"),
            ],
        )

        # Origen (https://dxxxx.cloudfront.net) que usan CORS de S3 y de la API.
        self.origin = f"https://{self.distribution.distribution_domain_name}"

        CfnOutput(self, "WebUrl", value=self.origin)
        CfnOutput(self, "WebBucketName", value=self.bucket.bucket_name)
        CfnOutput(self, "DistributionId", value=self.distribution.distribution_id)
