variable "function_name" {
  description = "Name of the Lambda function"
  type        = string
}

variable "description" {
  description = "Description of the Lambda function"
  type        = string
  default     = "Lambda function created by Terraform"
}

variable "handler" {
  description = "Lambda function handler"
  type        = string
  default     = "lambda_function.lambda_handler"
}

variable "runtime" {
  description = "Lambda function runtime"
  type        = string
  default     = "python3.11"
}

variable "timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = 30
}

variable "memory_size" {
  description = "Amount of memory in MB your Lambda function can use at runtime"
  type        = number
  default     = 128
}

variable "source_dir" {
  description = "Source directory containing Lambda function code"
  type        = string
}

variable "environment_variables" {
  description = "Environment variables for the Lambda function"
  type        = map(string)
  default     = {}
}

variable "additional_policy_arns" {
  description = "List of additional IAM policy ARNs to attach to the Lambda execution role"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "A map of tags to assign to the resource"
  type        = map(string)
  default     = {}
}

variable "layers" {
  description = "List of Lambda layer ARNs to attach to the function"
  type        = list(string)
  default     = []
}

# SQS Configuration Variables
variable "sqs_queue_name" {
  description = "Name of the SQS queue (defaults to '{function_name}-queue')"
  type        = string
  default     = null
}

variable "sqs_fifo_queue" {
  description = "Whether to create a FIFO queue"
  type        = bool
  default     = false
}

variable "sqs_enable_dlq" {
  description = "Whether to create a Dead Letter Queue"
  type        = bool
  default     = false
}

variable "sqs_visibility_timeout_seconds" {
  description = "Visibility timeout for SQS messages (defaults to Lambda timeout + 60 seconds)"
  type        = number
  default     = null
}

variable "sqs_message_retention_seconds" {
  description = "Message retention period in seconds (defaults to 14 days)"
  type        = number
  default     = null
}

variable "sqs_delay_seconds" {
  description = "Delay in seconds before messages become available (defaults to 0)"
  type        = number
  default     = null
}

variable "sqs_max_message_size" {
  description = "Maximum message size in bytes (defaults to 256 KB)"
  type        = number
  default     = null
}

variable "sqs_receive_wait_time_seconds" {
  description = "Long polling wait time in seconds (defaults to 0)"
  type        = number
  default     = null
}

variable "sqs_max_receive_count" {
  description = "Maximum number of times a message can be received before moving to DLQ (defaults to 3)"
  type        = number
  default     = null
}

variable "sqs_dlq_message_retention_seconds" {
  description = "Message retention period in seconds for the Dead Letter Queue (defaults to main queue retention)"
  type        = number
  default     = null
}

variable "sqs_dlq_visibility_timeout_seconds" {
  description = "Visibility timeout in seconds for the Dead Letter Queue (defaults to 30 seconds)"
  type        = number
  default     = null
}

variable "sqs_content_based_deduplication" {
  description = "Enable content-based deduplication for FIFO queues"
  type        = bool
  default     = false
}

variable "sqs_batch_size" {
  description = "Batch size for SQS event source mapping (defaults to 1)"
  type        = number
  default     = null
}

variable "sqs_max_batching_window_seconds" {
  description = "Maximum batching window in seconds for SQS event source mapping (defaults to 0)"
  type        = number
  default     = null
}

variable "sqs_function_response_types" {
  description = "Function response types for SQS event source mapping (for partial batch failures)"
  type        = list(string)
  default     = []
}

variable "sqs_enable_event_source_mapping" {
  description = "Whether to create an event source mapping from SQS to Lambda (defaults to true)"
  type        = bool
  default     = true
}

variable "reserved_concurrent_executions" {
  description = "Reserved concurrent executions for the Lambda function (optional)"
  type        = number
  default     = null
}

# KMS Configuration
variable "kms_key_id" {
  description = "KMS key ID for SQS encryption (optional)"
  type        = string
  default     = null
}

variable "kms_data_key_reuse_period_seconds" {
  description = "KMS data key reuse period in seconds (defaults to 300)"
  type        = number
  default     = null
}

# Wrapper Lambda Configuration
variable "enable_wrapper_lambda" {
  description = "Whether to create a wrapper Lambda function for synchronous API Gateway integration"
  type        = bool
  default     = false
}

variable "wrapper_timeout" {
  description = "Timeout in seconds for the wrapper Lambda function"
  type        = number
  default     = 300
}

variable "sns_topic_name" {
  description = "Name for the SNS topic used for completion notifications (defaults to '{function_name}-completion' if not provided)"
  type        = string
  default     = null
}

variable "response_table_name" {
  description = "DynamoDB table name for storing request/response correlation (optional)"
  type        = string
  default     = null
}

variable "wrapper_layers" {
  description = "List of Lambda layer ARNs to attach to the wrapper function"
  type        = list(string)
  default     = []
}

variable "completion_sns_env_var_name" {
  description = "Environment variable name for the completion SNS topic ARN in the worker Lambda"
  type        = string
  default     = "COMPLETION_SNS_TOPIC_ARN"
}
