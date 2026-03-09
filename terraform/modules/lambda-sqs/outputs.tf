# Lambda-SQS Module Outputs
# modules/lambda-sqs/outputs.tf
# All outputs from base lambda module plus SQS-specific outputs

# ============================================================================
# BASE LAMBDA OUTPUTS (same as base lambda module)
# ============================================================================

output "function_name" {
  description = "Name of the Lambda function"
  value       = aws_lambda_function.function.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function"
  value       = aws_lambda_function.function.arn
}

output "invoke_arn" {
  description = "Invoke ARN of the Lambda function"
  value       = aws_lambda_function.function.invoke_arn
}

output "execution_role_arn" {
  description = "ARN of the Lambda execution role"
  value       = aws_iam_role.lambda_execution_role.arn
}

output "execution_role_name" {
  description = "Name of the Lambda execution role"
  value       = aws_iam_role.lambda_execution_role.name
}

output "source_code_hash" {
  description = "Base64-encoded SHA256 hash of the deployment package"
  value       = aws_lambda_function.function.source_code_hash
}

output "deployment_package_path" {
  description = "Path to the deployment package"
  value       = data.archive_file.lambda_zip.output_path
}

# ============================================================================
# SQS-SPECIFIC OUTPUTS
# ============================================================================

output "sqs_queue_name" {
  description = "Name of the SQS queue"
  value       = aws_sqs_queue.main.name
}

output "sqs_queue_arn" {
  description = "ARN of the SQS queue"
  value       = aws_sqs_queue.main.arn
}

output "sqs_queue_url" {
  description = "URL of the SQS queue"
  value       = aws_sqs_queue.main.url
}

output "sqs_queue_id" {
  description = "ID of the SQS queue"
  value       = aws_sqs_queue.main.id
}

output "sqs_dlq_name" {
  description = "Name of the dead letter queue (null if DLQ not enabled)"
  value       = var.sqs_enable_dlq ? aws_sqs_queue.dlq[0].name : null
}

output "sqs_dlq_arn" {
  description = "ARN of the dead letter queue (null if DLQ not enabled)"
  value       = var.sqs_enable_dlq ? aws_sqs_queue.dlq[0].arn : null
}

output "sqs_dlq_url" {
  description = "URL of the dead letter queue (null if DLQ not enabled)"
  value       = var.sqs_enable_dlq ? aws_sqs_queue.dlq[0].url : null
}

output "sqs_dlq_id" {
  description = "ID of the dead letter queue (null if DLQ not enabled)"
  value       = var.sqs_enable_dlq ? aws_sqs_queue.dlq[0].id : null
}

output "sqs_read_policy_arn" {
  description = "ARN of the IAM policy for Lambda to read from SQS"
  value       = aws_iam_policy.sqs_read_policy.arn
}

output "sqs_event_source_mapping_id" {
  description = "ID of the event source mapping connecting SQS to Lambda (null if event source mapping not enabled)"
  value       = var.sqs_enable_event_source_mapping ? aws_lambda_event_source_mapping.sqs_trigger[0].id : null
}

output "sqs_event_source_mapping_uuid" {
  description = "UUID of the event source mapping connecting SQS to Lambda (null if event source mapping not enabled)"
  value       = var.sqs_enable_event_source_mapping ? aws_lambda_event_source_mapping.sqs_trigger[0].uuid : null
}

# Queue attributes for reference
output "sqs_queue_attributes" {
  description = "Map of SQS queue attributes"
  value = {
    name                        = aws_sqs_queue.main.name
    arn                         = aws_sqs_queue.main.arn
    url                         = aws_sqs_queue.main.url
    message_retention_seconds   = aws_sqs_queue.main.message_retention_seconds
    visibility_timeout_seconds  = aws_sqs_queue.main.visibility_timeout_seconds
    delay_seconds               = aws_sqs_queue.main.delay_seconds
    max_message_size            = aws_sqs_queue.main.max_message_size
    receive_wait_time_seconds   = aws_sqs_queue.main.receive_wait_time_seconds
    fifo_queue                  = aws_sqs_queue.main.fifo_queue
    content_based_deduplication = aws_sqs_queue.main.content_based_deduplication
  }
}

# ============================================================================
# WRAPPER LAMBDA OUTPUTS (when enabled)
# ============================================================================

output "wrapper_function_name" {
  description = "Name of the wrapper Lambda function (null if not enabled)"
  value       = var.enable_wrapper_lambda ? aws_lambda_function.wrapper[0].function_name : null
}

output "wrapper_function_arn" {
  description = "ARN of the wrapper Lambda function (null if not enabled)"
  value       = var.enable_wrapper_lambda ? aws_lambda_function.wrapper[0].arn : null
}

output "wrapper_invoke_arn" {
  description = "Invoke ARN of the wrapper Lambda function (null if not enabled)"
  value       = var.enable_wrapper_lambda ? aws_lambda_function.wrapper[0].invoke_arn : null
}

output "sns_topic_arn" {
  description = "ARN of the SNS topic for completion notifications (null if wrapper not enabled)"
  value       = var.enable_wrapper_lambda ? aws_sns_topic.completion[0].arn : null
}

output "sns_topic_name" {
  description = "Name of the SNS topic for completion notifications (null if wrapper not enabled)"
  value       = var.enable_wrapper_lambda ? aws_sns_topic.completion[0].name : null
}