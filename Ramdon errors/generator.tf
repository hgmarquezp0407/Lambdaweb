# ---------- Log group propio ----------
resource "aws_cloudwatch_log_group" "generator" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 7
}

# ---------- IAM (generador) ----------
data "aws_iam_policy_document" "generator_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "generator" {
  name               = "${local.name}-role"
  assume_role_policy = data.aws_iam_policy_document.generator_assume.json
}

resource "aws_iam_role_policy_attachment" "generator_basic" {
  role       = aws_iam_role.generator.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "generator_put_logs" {
  name = "${local.name}-put-logs"
  role = aws_iam_role.generator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = [for g in aws_cloudwatch_log_group.apps : "${g.arn}:*"]
    }]
  })
}

# ---------- Lambda ----------
data "archive_file" "generator_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_lambda_function" "generator" {
  function_name    = local.name
  role             = aws_iam_role.generator.arn
  runtime          = "python3.12"
  handler          = "handler.lambda_handler"
  filename         = data.archive_file.generator_zip.output_path
  source_code_hash = data.archive_file.generator_zip.output_base64sha256
  timeout          = 30
  memory_size      = 128

  depends_on = [
    aws_cloudwatch_log_group.generator,
    aws_iam_role_policy_attachment.generator_basic,
    aws_iam_role_policy.generator_put_logs,
  ]
}

output "generator_lambda" {
  value = aws_lambda_function.generator.function_name
}