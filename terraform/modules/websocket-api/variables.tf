# WebSocket API Gateway Module Variables
# modules/websocket-api/variables.tf

variable "api_name" {
  description = "Name of the WebSocket API Gateway"
  type        = string
}

variable "api_description" {
  description = "Description of the WebSocket API Gateway"
  type        = string
  default     = "WebSocket API for real-time chat functionality"
}

variable "stage_name" {
  description = "Name of the WebSocket API Gateway stage"
  type        = string
  default     = "production"
}

variable "connection_lambda_arn" {
  description = "ARN of the Lambda function for connection management"
  type        = string
}

variable "connection_lambda_name" {
  description = "Name of the Lambda function for connection management"
  type        = string
}

variable "message_lambda_arn" {
  description = "ARN of the Lambda function for message processing"
  type        = string
}

variable "message_lambda_name" {
  description = "Name of the Lambda function for message processing"
  type        = string
}

variable "tags" {
  description = "Tags to apply to the WebSocket API Gateway resources"
  type        = map(string)
  default     = {}
}
