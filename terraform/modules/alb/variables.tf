# ALB Module Variables
# modules/alb/variables.tf

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (development, staging, production)"
  type        = string
}

variable "tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  description = "VPC ID where ALB will be deployed"
  type        = string
}

variable "public_subnet_ids" {
  description = "List of public subnet IDs for ALB"
  type        = list(string)
}

variable "certificate_arn" {
  description = "ARN of SSL certificate for HTTPS"
  type        = string
  default     = "arn:aws:acm:us-east-1:676206904242:certificate/7f8d2b7b-d9d7-4ba8-9795-ddd3c11d8361"
}

variable "enable_https" {
  description = "Enable HTTPS listeners (requires certificate_arn when true)"
  type        = bool
  default     = false
}

variable "enable_deletion_protection" {
  description = "Enable deletion protection for ALB"
  type        = bool
  default     = false
}

variable "enable_access_logs" {
  description = "Enable access logs for ALB"
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "S3 bucket name for ALB access logs"
  type        = string
  default     = ""
}

variable "kms_key_arn" {
  description = "ARN of the KMS key for encryption"
  type        = string
}

variable "rate_limit" {
  description = "Rate limit for WAF (requests per 5 minutes)"
  type        = number
  default     = 2000
}

variable "blocked_countries" {
  description = "List of country codes to block"
  type        = list(string)
  default     = []
}

variable "enable_waf_logging" {
  description = "Enable WAF logging to CloudWatch"
  type        = bool
  default     = true
}
