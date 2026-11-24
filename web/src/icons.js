// Iconos oficiales de servicio de AWS (AWS Architecture Icons). Ver assets/aws/NOTICE.md.
// Vite entrega cada .svg como URL (o data-URI si es pequeño), listo para <img>/<image>.
import lambda from './assets/aws/lambda.svg';
import cognito from './assets/aws/cognito.svg';
import s3 from './assets/aws/s3.svg';
import stepFunctions from './assets/aws/step-functions.svg';
import glue from './assets/aws/glue.svg';
import athena from './assets/aws/athena.svg';
import apiGateway from './assets/aws/api-gateway.svg';
import cloudfront from './assets/aws/cloudfront.svg';

export const ICONS = { lambda, cognito, s3, stepFunctions, glue, athena, apiGateway, cloudfront };
export const ICON_LABELS = {
  lambda: 'AWS Lambda', cognito: 'Amazon Cognito', s3: 'Amazon S3', stepFunctions: 'AWS Step Functions',
  glue: 'AWS Glue', athena: 'Amazon Athena', apiGateway: 'Amazon API Gateway', cloudfront: 'Amazon CloudFront',
};
