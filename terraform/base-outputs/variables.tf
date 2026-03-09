variable "environment" {
  description = "Environment (staging or production)"
  type        = string
}

variable "state_bucket" {
  description = "S3 bucket for Terraform state (same as base infra)"
  type        = string
}

variable "state_region" {
  description = "AWS region where state bucket lives"
  type        = string
  default     = "eu-central-1"
}

variable "state_dynamodb_table" {
  description = "DynamoDB table for state locking"
  type        = string
}
