# Lambda Module with Built-in SQS Support
# modules/lambda-sqs/main.tf
# This is a functional clone of the base lambda module with integrated SQS queue support

# Data source for creating zip file from source directory
# IMPROVED: Better change detection and path handling
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${var.source_dir}/deployment.zip"

  # Exclude files that shouldn't trigger rebuilds
  excludes = [
    "deployment.zip", # Exclude the output file itself
    "__pycache__/**", # Exclude Python cache files
    "*.pyc",          # Exclude compiled Python files
    ".git/**",        # Exclude git files if present
    ".DS_Store",      # Exclude macOS files
    "Thumbs.db"       # Exclude Windows files
  ]
}

# Data sources for AWS account and region info (needed for KMS policies)
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# IAM Role for Lambda execution
resource "aws_iam_role" "lambda_execution_role" {
  name = "${var.function_name}-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

# Basic execution policy attachment
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Attach additional IAM policies
resource "aws_iam_role_policy_attachment" "additional_policies" {
  count      = length(var.additional_policy_arns)
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = var.additional_policy_arns[count.index]
}

# Lambda Function
resource "aws_lambda_function" "function" {
  function_name = var.function_name
  description   = var.description
  role          = aws_iam_role.lambda_execution_role.arn
  handler       = var.handler
  runtime       = var.runtime
  timeout       = var.timeout
  memory_size   = var.memory_size

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = merge(
      var.environment_variables,
      var.enable_wrapper_lambda ? {
        # Add completion SNS topic ARN to worker Lambda environment variables
        (var.completion_sns_env_var_name != null ? var.completion_sns_env_var_name : "${upper(replace(var.function_name, "-", "_"))}_COMPLETION_SNS_TOPIC_ARN") = aws_sns_topic.completion[0].arn
      } : {}
    )
  }

  layers = var.layers

  # Reserved concurrency (if specified)
  reserved_concurrent_executions = var.reserved_concurrent_executions

  tags = var.tags
}

# ============================================================================
# SQS QUEUE CONFIGURATION
# ============================================================================

# Local values for SQS configuration
locals {
  # Queue name defaults to function name if not provided
  # For FIFO queues, automatically append .fifo suffix if not already present
  base_queue_name = var.sqs_queue_name != null ? var.sqs_queue_name : "${var.function_name}-queue"
  sqs_queue_name  = var.sqs_fifo_queue && !endswith(local.base_queue_name, ".fifo") ? "${local.base_queue_name}.fifo" : local.base_queue_name

  # Visibility timeout should be >= Lambda timeout (AWS requirement)
  # Default to Lambda timeout + 60 seconds buffer, or use provided value
  sqs_visibility_timeout = var.sqs_visibility_timeout_seconds != null ? var.sqs_visibility_timeout_seconds : (var.timeout + 60)

  # Message retention: default 14 days (1209600 seconds)
  sqs_message_retention = var.sqs_message_retention_seconds != null ? var.sqs_message_retention_seconds : 1209600
}

# Dead Letter Queue (optional)
resource "aws_sqs_queue" "dlq" {
  count = var.sqs_enable_dlq ? 1 : 0

  name                       = var.sqs_fifo_queue ? "${replace(local.sqs_queue_name, ".fifo", "")}-dlq.fifo" : "${local.sqs_queue_name}-dlq"
  message_retention_seconds  = var.sqs_dlq_message_retention_seconds != null ? var.sqs_dlq_message_retention_seconds : local.sqs_message_retention
  visibility_timeout_seconds = var.sqs_dlq_visibility_timeout_seconds != null ? var.sqs_dlq_visibility_timeout_seconds : 30

  # Server-side encryption (if KMS key provided)
  kms_master_key_id                 = var.kms_key_id
  kms_data_key_reuse_period_seconds = var.kms_data_key_reuse_period_seconds != null ? var.kms_data_key_reuse_period_seconds : 300

  # FIFO queue configuration (must match main queue)
  fifo_queue                  = var.sqs_fifo_queue
  content_based_deduplication = var.sqs_fifo_queue && var.sqs_content_based_deduplication ? true : false

  tags = merge(var.tags, {
    Name    = var.sqs_fifo_queue ? "${replace(local.sqs_queue_name, ".fifo", "")}-dlq.fifo" : "${local.sqs_queue_name}-dlq"
    Type    = "DeadLetterQueue"
    Purpose = "DLQ for ${var.function_name}"
  })
}

# Main SQS Queue
resource "aws_sqs_queue" "main" {
  name                       = local.sqs_queue_name
  message_retention_seconds  = local.sqs_message_retention
  visibility_timeout_seconds = local.sqs_visibility_timeout
  delay_seconds              = var.sqs_delay_seconds != null ? var.sqs_delay_seconds : 0
  max_message_size           = var.sqs_max_message_size != null ? var.sqs_max_message_size : 262144 # 256 KB
  receive_wait_time_seconds  = var.sqs_receive_wait_time_seconds != null ? var.sqs_receive_wait_time_seconds : 0

  # Dead Letter Queue configuration
  redrive_policy = var.sqs_enable_dlq ? jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[0].arn
    maxReceiveCount     = var.sqs_max_receive_count != null ? var.sqs_max_receive_count : 3
  }) : null

  # Server-side encryption (if KMS key provided)
  kms_master_key_id                 = var.kms_key_id
  kms_data_key_reuse_period_seconds = var.kms_data_key_reuse_period_seconds != null ? var.kms_data_key_reuse_period_seconds : 300

  # FIFO queue configuration
  fifo_queue                  = var.sqs_fifo_queue
  content_based_deduplication = var.sqs_fifo_queue && var.sqs_content_based_deduplication ? true : false

  tags = merge(var.tags, {
    Name    = local.sqs_queue_name
    Type    = "SQSQueue"
    Purpose = "Queue for ${var.function_name}"
  })
}

# SQS Queue Policy: only wrapper can send, only root Lambda can receive (least privilege)
resource "aws_sqs_queue_policy" "main" {
  count = var.enable_wrapper_lambda ? 1 : 0

  queue_url = aws_sqs_queue.main.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowWrapperSend"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.wrapper_execution_role[0].arn
        }
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.main.arn
      },
      {
        Sid    = "AllowRootReceive"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.lambda_execution_role.arn
        }
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ]
        Resource = aws_sqs_queue.main.arn
      }
    ]
  })
}

# IAM Policy for Lambda to read from SQS
resource "aws_iam_policy" "sqs_read_policy" {
  name        = "${var.function_name}-sqs-read-policy"
  description = "Policy for ${var.function_name} Lambda to read from SQS queue"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Effect = "Allow"
          Action = [
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
            "sqs:ChangeMessageVisibility"
          ]
          Resource = [
            aws_sqs_queue.main.arn
          ]
        }
      ],
      var.sqs_enable_dlq ? [
        {
          Effect = "Allow"
          Action = [
            "sqs:GetQueueAttributes"
          ]
          Resource = [
            aws_sqs_queue.dlq[0].arn
          ]
        }
      ] : [],
      var.kms_key_id != null ? [
        {
          Effect = "Allow"
          Action = [
            "kms:Decrypt",
            "kms:GenerateDataKey",
            "kms:DescribeKey"
          ]
          Resource = [
            "arn:aws:kms:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:key/${var.kms_key_id}"
          ]
        }
      ] : []
    )
  })

  tags = var.tags
}

# Attach SQS read policy to Lambda execution role
resource "aws_iam_role_policy_attachment" "sqs_read_policy" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = aws_iam_policy.sqs_read_policy.arn
}

# Event Source Mapping: SQS Queue -> Lambda Function
resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  count = var.sqs_enable_event_source_mapping ? 1 : 0

  event_source_arn                   = aws_sqs_queue.main.arn
  function_name                      = aws_lambda_function.function.function_name
  batch_size                         = var.sqs_batch_size != null ? var.sqs_batch_size : 1
  maximum_batching_window_in_seconds = var.sqs_max_batching_window_seconds != null ? var.sqs_max_batching_window_seconds : 0
  enabled                            = true

  # Function response types (for partial batch failures)
  function_response_types = var.sqs_function_response_types

  depends_on = [
    aws_lambda_function.function,
    aws_sqs_queue.main,
    aws_iam_role_policy_attachment.sqs_read_policy
  ]
}

# ============================================================================
# WRAPPER LAMBDA CONFIGURATION (for synchronous API Gateway responses)
# ============================================================================

# Local values for wrapper configuration
locals {
  # SNS topic name defaults to function name if not provided
  sns_topic_name = var.sns_topic_name != null ? var.sns_topic_name : "${var.function_name}-completion"

  # Wrapper function name
  wrapper_function_name = "${var.function_name}-wrapper"

  # IAM role names max 64 chars: use -wrapper-role suffix (saves 8 chars vs -execution-role)
  # If still too long, truncate function name
  wrapper_role_name = length("${local.wrapper_function_name}-wrapper-role") > 64 ? "${substr(local.wrapper_function_name, 0, 64 - 13)}-wr-role" : "${local.wrapper_function_name}-wrapper-role"
}

# SNS Topic for completion notifications
resource "aws_sns_topic" "completion" {
  count = var.enable_wrapper_lambda ? 1 : 0

  name = local.sns_topic_name

  tags = merge(var.tags, {
    Name    = local.sns_topic_name
    Type    = "SNSTopic"
    Purpose = "Completion notifications for ${var.function_name}"
  })
}

# Data source for wrapper Lambda source directory
data "archive_file" "wrapper_lambda_zip" {
  count = var.enable_wrapper_lambda ? 1 : 0

  type        = "zip"
  source_dir  = "${path.root}/../backend_app/src/lambda_wrapper/app"
  output_path = "${path.root}/../backend_app/src/lambda_wrapper/app/deployment.zip"

  excludes = [
    "deployment.zip",
    "__pycache__/**",
    "*.pyc",
    ".git/**",
    ".DS_Store",
    "Thumbs.db"
  ]
}

# IAM Role for Wrapper Lambda execution
resource "aws_iam_role" "wrapper_execution_role" {
  count = var.enable_wrapper_lambda ? 1 : 0

  # Use shorter name to stay within 64 character limit
  # IAM role names max 64 chars: use -wrapper-role suffix (saves 8 chars vs -execution-role)
  name = local.wrapper_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

# Basic execution policy attachment for wrapper
resource "aws_iam_role_policy_attachment" "wrapper_basic_execution" {
  count = var.enable_wrapper_lambda ? 1 : 0

  role       = aws_iam_role.wrapper_execution_role[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# IAM Policy for Wrapper Lambda to send messages to SQS only (no receive/list)
resource "aws_iam_policy" "wrapper_sqs_send_policy" {
  count = var.enable_wrapper_lambda ? 1 : 0

  name        = "${local.wrapper_function_name}-sqs-send-policy"
  description = "Policy for ${local.wrapper_function_name} to send messages to SQS queue only"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Effect   = "Allow"
          Action   = ["sqs:SendMessage"]
          Resource = [aws_sqs_queue.main.arn]
        }
      ],
      var.kms_key_id != null ? [
        {
          Effect = "Allow"
          Action = [
            "kms:Decrypt",
            "kms:GenerateDataKey",
            "kms:DescribeKey"
          ]
          Resource = [
            "arn:aws:kms:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:key/${var.kms_key_id}"
          ]
        }
      ] : []
    )
  })

  tags = var.tags
}

# IAM Policy for Wrapper Lambda to invoke root/worker Lambda only (direct invoke; no other Lambda access)
resource "aws_iam_policy" "wrapper_lambda_invoke_policy" {
  count = var.enable_wrapper_lambda ? 1 : 0

  name        = "${local.wrapper_function_name}-lambda-invoke-policy"
  description = "Policy for ${local.wrapper_function_name} to invoke worker Lambda function only"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [aws_lambda_function.function.arn]
      }
    ]
  })

  tags = var.tags
}

# Attach policies to wrapper execution role (SQS send + Lambda invoke only; no SNS - wrapper is invoked by SNS)
resource "aws_iam_role_policy_attachment" "wrapper_sqs_send_policy" {
  count = var.enable_wrapper_lambda ? 1 : 0

  role       = aws_iam_role.wrapper_execution_role[0].name
  policy_arn = aws_iam_policy.wrapper_sqs_send_policy[0].arn
}

resource "aws_iam_role_policy_attachment" "wrapper_lambda_invoke_policy" {
  count = var.enable_wrapper_lambda ? 1 : 0

  role       = aws_iam_role.wrapper_execution_role[0].name
  policy_arn = aws_iam_policy.wrapper_lambda_invoke_policy[0].arn
}

# Wrapper Lambda Function
resource "aws_lambda_function" "wrapper" {
  count = var.enable_wrapper_lambda ? 1 : 0

  function_name = local.wrapper_function_name
  description   = "Wrapper Lambda for ${var.function_name} - handles synchronous API Gateway requests via SQS"
  role          = aws_iam_role.wrapper_execution_role[0].arn
  handler       = "lambda_function.lambda_handler"
  runtime       = "python3.11"
  timeout       = var.wrapper_timeout
  memory_size   = 256

  filename         = data.archive_file.wrapper_lambda_zip[0].output_path
  source_code_hash = data.archive_file.wrapper_lambda_zip[0].output_base64sha256

  environment {
    variables = {
      SQS_QUEUE_URL        = aws_sqs_queue.main.url
      SNS_TOPIC_ARN        = aws_sns_topic.completion[0].arn
      WORKER_FUNCTION_NAME = aws_lambda_function.function.function_name
      RESPONSE_TABLE_NAME  = var.response_table_name != null ? var.response_table_name : ""
    }
  }

  layers = var.wrapper_layers

  tags = var.tags
}

# SNS Subscription: SNS Topic -> Wrapper Lambda (for completion callbacks)
resource "aws_sns_topic_subscription" "wrapper_subscription" {
  count = var.enable_wrapper_lambda ? 1 : 0

  topic_arn = aws_sns_topic.completion[0].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.wrapper[0].arn
}

# Lambda Permission: Allow SNS to invoke the wrapper Lambda
resource "aws_lambda_permission" "wrapper_sns_invoke" {
  count = var.enable_wrapper_lambda ? 1 : 0

  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.wrapper[0].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.completion[0].arn
}

# IAM Policy for Worker Lambda to publish to SNS (add to existing policies)
resource "aws_iam_policy" "worker_sns_publish_policy" {
  count = var.enable_wrapper_lambda ? 1 : 0

  name        = "${var.function_name}-sns-publish-policy"
  description = "Policy for ${var.function_name} worker Lambda to publish completion to SNS"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = [
          aws_sns_topic.completion[0].arn
        ]
      }
    ]
  })

  tags = var.tags
}

# Attach SNS publish policy to worker Lambda execution role
resource "aws_iam_role_policy_attachment" "worker_sns_publish_policy" {
  count = var.enable_wrapper_lambda ? 1 : 0

  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = aws_iam_policy.worker_sns_publish_policy[0].arn
}