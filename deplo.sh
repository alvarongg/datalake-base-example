#!/usr/bin/env bash
# =============================================================================
# deplo.sh · Despliegue completo del data lake medallion de ejemplo
# =============================================================================
# TODO el paso a paso (build de la web + despliegue CDK Python) vive en este
# archivo, en orden y comentado, para que cualquier ingeniero pueda leerlo
# como si fuera un tutorial.
#
# Uso:
#   ./deplo.sh              Despliega todo (equivale a "deploy")
#   ./deplo.sh seed         Sube los CSV de sample-data/ al bucket landing
#   ./deplo.sh run [dataset] [modo]
#                           Procesa archivos y espera el resultado. Sin argumentos procesa TODOS
#                           en orden de dependencias. Con dataset: modo "single" (default; falla si
#                           una dependencia no está al día) o "with_dependencies" (en orden).
#                           Ej.: ./deplo.sh run products               -> falla sin product_subcategories
#                                ./deplo.sh run products with_dependencies
#   ./deplo.sh gold         Construye los modelos Gold (exige Silver al día) y espera
#   ./deplo.sh reset        Vacía bronze/silver/gold + tablas (conserva los CSV)
#   ./deplo.sh reset-all    Igual que reset pero también vacía landing
#   ./deplo.sh destroy      Elimina TODA la infraestructura (cdk destroy)
#   ./deplo.sh test         Solo corre los tests
#
# Variables opcionales:
#   AWS_PROFILE          perfil de AWS CLI           (default: udemy_alvaro)
#   AWS_REGION           región                      (default: us-east-1)
#   DEMO_USER_EMAIL      usuario de Cognito a crear  (default: demo@example.com)
#   DEMO_USER_PASSWORD   contraseña del usuario      (default: se genera al azar)
#   SKIP_TESTS=1         salta los tests antes de desplegar
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"

# ---------------------------------------------------------------------------
# 0. Configuración
# ---------------------------------------------------------------------------
export AWS_PROFILE="${AWS_PROFILE:-udemy_alvaro}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""                                  # evita que la CLI abra un paginador
export JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1  # CDK usa jsii (Node) por debajo
export JSII_RUNTIME_PACKAGE_CACHE=disabled           # evita un error de permisos del caché en contenedores

DEMO_USER_EMAIL="${DEMO_USER_EMAIL:-demo@example.com}"
CDK_CLI="aws-cdk@2"                                  # CLI de CDK, se ejecuta con npx (sin instalar global)
VENV="$ROOT/.venv"
OUTPUTS_FILE="$ROOT/infra/cdk-outputs.json"

# Nombres de los stacks (deben coincidir con infra/app.py)
S_WEB="DatalakeDemo-Web"; S_AUTH="DatalakeDemo-Auth"; S_LAKE="DatalakeDemo-Lake"
S_PIPE="DatalakeDemo-Pipeline"; S_API="DatalakeDemo-Api"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Lee una salida (Output) de un stack de CloudFormation.
output() {  # uso: output <stack> <OutputKey>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# ---------------------------------------------------------------------------
# 1. Prerrequisitos y credenciales
# ---------------------------------------------------------------------------
check_prereqs() {
  log "1/9 Verificando herramientas y credenciales (perfil: $AWS_PROFILE, región: $AWS_REGION)"
  for bin in aws node npm python3; do
    command -v "$bin" >/dev/null || fail "Falta '$bin' en el PATH"
  done
  # Si las credenciales no sirven, fallamos ya, antes de construir nada.
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
    || fail "El perfil '$AWS_PROFILE' no tiene credenciales válidas (prueba 'aws sso login' o 'aws configure')"
  export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" CDK_DEFAULT_REGION="$AWS_REGION"
  echo "Cuenta AWS: $ACCOUNT_ID"
}

# ---------------------------------------------------------------------------
# 2. Entorno Python (CDK + tests)
# ---------------------------------------------------------------------------
setup_python() {
  log "2/9 Preparando entorno Python (.venv)"
  [ -d "$VENV" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r requirements-dev.txt
  export PATH="$VENV/bin:$PATH"   # cdk.json ejecuta "python3 app.py": debe ser el del venv
}

# ---------------------------------------------------------------------------
# 3. Tests (transformaciones, validador SQL, modelos Gold, infraestructura)
# ---------------------------------------------------------------------------
run_tests() {
  log "3/9 Ejecutando tests"
  "$VENV/bin/python" -m pytest -q
}

# ---------------------------------------------------------------------------
# 4. Bootstrap de CDK (una sola vez por cuenta/región)
# ---------------------------------------------------------------------------
cdk_bootstrap() {
  log "4/9 Verificando bootstrap de CDK"
  if aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
    echo "CDKToolkit ya existe, se omite."
  else
    (cd infra && npx --yes "$CDK_CLI" bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$AWS_REGION")
  fi
}

# ---------------------------------------------------------------------------
# 5. Despliegue de la infraestructura (CDK Python)
# ---------------------------------------------------------------------------
cdk_deploy() {
  log "5/9 Desplegando stacks con CDK (Web, Auth, Lake, Pipeline, Api)"
  (cd infra && npx --yes "$CDK_CLI" deploy --all --require-approval never \
      --outputs-file "$OUTPUTS_FILE")
}

# ---------------------------------------------------------------------------
# 6-7. Build de la web: config.json con las salidas de CDK + vite build
# ---------------------------------------------------------------------------
build_web() {
  log "6/9 Generando web/public/config.json con las salidas de CloudFormation"
  cat > web/public/config.json <<EOF
{
  "region": "$AWS_REGION",
  "userPoolId": "$(output "$S_AUTH" UserPoolId)",
  "userPoolClientId": "$(output "$S_AUTH" UserPoolClientId)",
  "apiUrl": "$(output "$S_API" ApiUrl)"
}
EOF
  log "7/9 Compilando la web (npm + vite)"
  (cd web && npm install --no-audit --no-fund && npm run build)
}

# ---------------------------------------------------------------------------
# 8. Publicar la web en S3 + invalidar CloudFront
# ---------------------------------------------------------------------------
publish_web() {
  log "8/9 Publicando la web en S3 e invalidando CloudFront"
  local bucket dist
  bucket="$(output "$S_WEB" WebBucketName)"
  dist="$(output "$S_WEB" DistributionId)"
  # Assets con hash en el nombre: se pueden cachear un año.
  aws s3 sync web/dist "s3://$bucket" --delete \
    --exclude "index.html" --exclude "config.json" \
    --cache-control "public,max-age=31536000,immutable"
  # HTML y config: siempre se revalidan, para ver cambios al instante.
  aws s3 cp web/dist/index.html  "s3://$bucket/index.html"  --cache-control "no-cache"
  aws s3 cp web/dist/config.json "s3://$bucket/config.json" --cache-control "no-cache"
  aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" >/dev/null
}

# ---------------------------------------------------------------------------
# 9. Usuario de demostración en Cognito (sin auto-registro, lo crea el admin)
# ---------------------------------------------------------------------------
create_demo_user() {
  log "9/9 Creando usuario de demostración en Cognito"
  local pool password created=0
  pool="$(output "$S_AUTH" UserPoolId)"
  password="${DEMO_USER_PASSWORD:-$(python3 -c 'import secrets,string;a=string.ascii_letters+string.digits;print("".join(secrets.choice(a) for _ in range(14))+"-Aa1")')}"

  if aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$DEMO_USER_EMAIL" \
       --user-attributes "Name=email,Value=$DEMO_USER_EMAIL" "Name=email_verified,Value=true" \
       --message-action SUPPRESS >/dev/null 2>&1; then
    created=1
  fi
  # Solo fijamos contraseña si el usuario es nuevo o si el operador la pidió explícitamente.
  if [ "$created" = 1 ] || [ -n "${DEMO_USER_PASSWORD:-}" ]; then
    aws cognito-idp admin-set-user-password --user-pool-id "$pool" \
      --username "$DEMO_USER_EMAIL" --password "$password" --permanent
    echo "Usuario: $DEMO_USER_EMAIL"
    echo "Clave  : $password"
  else
    echo "El usuario $DEMO_USER_EMAIL ya existía; no se modificó su contraseña."
  fi
}

# ---------------------------------------------------------------------------
# Comandos auxiliares
# ---------------------------------------------------------------------------
cmd_seed() {
  check_prereqs
  local bucket; bucket="$(output "$S_LAKE" LandingBucketName)"
  log "Subiendo sample-data/*.csv a s3://$bucket/adventureworks/"
  aws s3 cp sample-data "s3://$bucket/adventureworks/" --recursive \
    --exclude "*" --include "*.csv" --content-type "text/csv"
}

# Inicia una ejecución de Step Functions y espera a que termine. Devuelve 1 si no fue SUCCEEDED.
wait_execution() {  # uso: wait_execution <state-machine-arn> <json-input>
  local exec status
  exec="$(aws stepfunctions start-execution --state-machine-arn "$1" --input "$2" --query executionArn --output text)"
  log "Ejecución iniciada: $exec"
  while true; do
    status="$(aws stepfunctions describe-execution --execution-arn "$exec" --query status --output text)"
    echo "  estado: $status"
    [ "$status" = "RUNNING" ] || break
    sleep 10
  done
  if [ "$status" != "SUCCEEDED" ]; then
    # Muestra el motivo (p. ej. "products no se puede procesar: product_subcategories nunca se procesó")
    aws stepfunctions get-execution-history --execution-arn "$exec" --reverse-order --max-items 20 \
      --query "events[?contains(type,'Failed')].[executionFailedEventDetails.cause,lambdaFunctionFailedEventDetails.cause]" \
      --output text | grep -v '^None' | head -3 || true
    return 1
  fi
}

cmd_run() {  # uso: run [dataset|all] [single|with_dependencies]
  check_prereqs
  local input
  input="$("$VENV/bin/python" scripts/plan_input.py "${1:-all}" "${2:-single}")" || fail "Argumentos inválidos"
  wait_execution "$(output "$S_PIPE" DatasetStateMachineArn)" "$input" || fail "El pipeline de datasets terminó con error"
}

cmd_gold() {
  check_prereqs
  wait_execution "$(output "$S_PIPE" GoldStateMachineArn)" '{"models": []}' || fail "El pipeline Gold terminó con error"
}

cmd_reset() {  # $1 = true|false (incluir landing)
  check_prereqs
  local fn; fn="$(output "$S_PIPE" ResetFunctionName)"
  log "Reiniciando el lake (incluye landing: $1)"
  aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
    --payload "{\"include_landing\": $1}" /dev/stdout | head -c 2000; echo
}

cmd_destroy() {
  check_prereqs
  read -r -p "Esto ELIMINA todos los stacks y datos de la demo. Escribe 'si' para continuar: " ok
  [ "$ok" = "si" ] || fail "Cancelado"
  setup_python
  (cd infra && npx --yes "$CDK_CLI" destroy --all --force)
}

cmd_deploy() {
  check_prereqs
  setup_python
  [ "${SKIP_TESTS:-0}" = 1 ] || run_tests
  cdk_bootstrap
  cdk_deploy
  build_web
  publish_web
  create_demo_user
  log "Listo ✔"
  echo "Web : $(output "$S_WEB" WebUrl)"
  echo "API : $(output "$S_API" ApiUrl)"
  echo "Siguiente paso: ./deplo.sh seed && ./deplo.sh run && ./deplo.sh gold   (o súbelos y procésalos desde la web)"
}

case "${1:-deploy}" in
  deploy)    cmd_deploy ;;
  seed)      cmd_seed ;;
  run)       shift; cmd_run "$@" ;;
  gold)      cmd_gold ;;
  reset)     cmd_reset false ;;
  reset-all) cmd_reset true ;;
  destroy)   cmd_destroy ;;
  test)      setup_python; run_tests ;;
  *)         fail "Comando desconocido '$1'. Ver cabecera de deplo.sh" ;;
esac
