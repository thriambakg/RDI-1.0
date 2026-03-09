# ECR Module Variables
# modules/ecr/variables.tf

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (development, staging, production)"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the KMS key for encryption"
  type        = string
}

variable "tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "repository_name" {
  description = "Name of the ECR repository (defaults to 'frontend')"
  type        = string
  default     = "frontend"
}