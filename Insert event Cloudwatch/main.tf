# =====================================================================
# FLUJO GENERAL
#
#  Lambda generadora (generator.tf) ──▶ Log groups (/app/demo-*)
#                                              │
#                          subscription filter { level = "ERROR" }
#                                              ▼
#                                  Lambda procesadora ──▶ DynamoDB
#
#  Además, un metric filter cuenta los ERROR como métrica en CloudWatch.
# =====================================================================


# ---------------------------------------------------------------------
# 1. TERRAFORM Y PROVIDERS
# Declara qué plugins necesita Terraform y sus versiones.
# - aws:     crea los recursos en AWS
# - archive: empaqueta las carpetas lambda/ en archivos .zip
# ---------------------------------------------------------------------
terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
}

# Región donde se crea todo.
provider "aws" {
  region = "us-east-1"
}


# ---------------------------------------------------------------------
# 2. LOCALS (variables internas)
# - name:       prefijo para nombrar todos los recursos
# - log_groups: los 3 servicios simulados; el código genera un log group
#               por cada uno gracias a for_each
# ---------------------------------------------------------------------
locals {
  name       = "demo-log"
  log_groups = ["/app/demo-api", "/app/demo-auth", "/app/demo-payments"]
}


# ---------------------------------------------------------------------
# 3. LOG GROUPS
# (Los 3 /app/* se comparten con generator.tf: mismo directorio = mismo módulo.)
# Contenedores de logs en CloudWatch. Retención de 7 días para no pagar
# almacenamiento infinito.
# ---------------------------------------------------------------------

# 3.1 Los 3 servicios simulados: aquí escribe la Lambda generadora.
resource "aws_cloudwatch_log_group" "apps" {
  for_each          = toset(local.log_groups)
  name              = each.value
  retention_in_days = 7
}

# 3.2 Log group propio de la Lambda procesadora.
resource "aws_cloudwatch_log_group" "errors_lambda" {
  name              = "/aws/lambda/${local.name}-errors"
  retention_in_days = 7
}


# ---------------------------------------------------------------------
# 4. DYNAMODB
# Tabla donde la Lambda procesadora guarda cada error.
# - PAY_PER_REQUEST: pagas por uso, sin capacidad fija
# - hash_key  "service": log group de origen (partition key)
# - range_key "sk":      "timestamp#id_evento" (ordena y evita duplicados)
# - attribute: solo se declaran las llaves (tabla e índice); el resto de
#   campos (message, level...) se guardan sin declararlos.
# ---------------------------------------------------------------------
resource "aws_dynamodb_table" "errors" {
  name         = "${local.name}-errors"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "service"
  range_key    = "sk"

  attribute {
    name = "service"
    type = "S" # S = string
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "request_id"
    type = "S"
  }

  # Índice secundario: permite buscar todos los errores de una request.
  global_secondary_index {
    name            = "request_id-index"
    hash_key        = "request_id"
    projection_type = "ALL" # el índice copia todos los campos
  }

  # TTL: DynamoDB borra solo los items cuando expires_at (epoch) vence.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}


# ---------------------------------------------------------------------
# 5. IAM (permisos)
# Rol de la Lambda procesadora (el generador tiene su propio rol en generator.tf).
# ---------------------------------------------------------------------

# 5.1 Política de confianza: permite que el servicio Lambda use el rol.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# 5.2 El rol de ejecución de la procesadora.
resource "aws_iam_role" "errors" {
  name               = "${local.name}-errors-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# 5.3 Política administrada de AWS: escribir los logs propios de la Lambda.
resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.errors.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# 5.4 La procesadora puede escribir en la tabla de errores (solo esa tabla).
resource "aws_iam_role_policy" "dynamodb_errors" {
  name = "${local.name}-dynamodb-errors"
  role = aws_iam_role.errors.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem", "dynamodb:BatchWriteItem"]
      Resource = aws_dynamodb_table.errors.arn
    }]
  })
}


# ---------------------------------------------------------------------
# 6. LAMBDA PROCESADORA DE ERRORES
# CloudWatch la invoca solo cuando aparece un ERROR; guarda cada error
# en DynamoDB.
# ---------------------------------------------------------------------

# 6.1 Comprime la carpeta lambda_errors/.
data "archive_file" "errors_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda_errors"
  output_path = "${path.module}/lambda_errors.zip"
}

# 6.2 La función. La conexión con DynamoDB es la variable de entorno
#     TABLE_NAME (el código la lee con os.environ["TABLE_NAME"]) más el
#     permiso del punto 5.4.
resource "aws_lambda_function" "errors" {
  function_name    = "${local.name}-errors"
  role             = aws_iam_role.errors.arn
  runtime          = "python3.12"
  handler          = "handler.lambda_handler"
  filename         = data.archive_file.errors_zip.output_path
  source_code_hash = data.archive_file.errors_zip.output_base64sha256
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.errors.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.errors_lambda,
    aws_iam_role_policy_attachment.basic,
    aws_iam_role_policy.dynamodb_errors,
  ]
}

# 6.3 Permiso de invocación: autoriza al servicio CloudWatch Logs
#     (logs.amazonaws.com) a llamar a esta Lambda, uno por cada log group.
resource "aws_lambda_permission" "from_logs" {
  for_each      = aws_cloudwatch_log_group.apps
  statement_id  = "AllowCWLogs-${replace(trimprefix(each.key, "/"), "/", "-")}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.errors.function_name
  principal     = "logs.amazonaws.com"
  source_arn    = "${each.value.arn}:*"
}


# ---------------------------------------------------------------------
# 7. SUBSCRIPTION FILTER (el "cable" log group → Lambda)
# Envía a la Lambda procesadora solo las líneas con level = ERROR.
# Los logs llegan comprimidos (base64 + gzip); el handler los decodifica.
# depends_on: el permiso 6.3 debe existir antes de crear el filtro.
# ---------------------------------------------------------------------
resource "aws_cloudwatch_log_subscription_filter" "errors" {
  for_each        = aws_cloudwatch_log_group.apps
  name            = "errors-to-lambda"
  log_group_name  = each.value.name
  filter_pattern  = "{ $.level = \"ERROR\" }"
  destination_arn = aws_lambda_function.errors.arn

  depends_on = [aws_lambda_permission.from_logs]
}


# ---------------------------------------------------------------------
# 8. METRIC FILTER
# Cuenta cada línea ERROR y la publica como métrica ErrorCount en el
# namespace DemoApp, con la dimensión Service (campo "service" del JSON).
# Sirve para graficar o crear alarmas más adelante.
# ---------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each       = aws_cloudwatch_log_group.apps
  name           = "errors-${replace(trimprefix(each.key, "/"), "/", "-")}"
  log_group_name = each.value.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name       = "ErrorCount"
    namespace  = "DemoApp"
    value      = "1"
    dimensions = { Service = "$.service" }
  }
}


# ---------------------------------------------------------------------
# 9. OUTPUTS
# Valores que Terraform imprime al terminar el apply.
# ---------------------------------------------------------------------
output "dynamodb_table" {
  value = aws_dynamodb_table.errors.name
}

output "errors_lambda" {
  value = aws_lambda_function.errors.function_name
}