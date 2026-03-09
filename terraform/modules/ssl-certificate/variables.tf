# SSL Certificate Module Variables
# modules/ssl-certificate/variables.tf

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (staging, production, etc.)"
  type        = string
}

variable "aws_region" {
  description = "AWS region for the SSL certificate"
  type        = string
}

variable "tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}
