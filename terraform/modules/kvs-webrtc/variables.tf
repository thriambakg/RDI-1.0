variable "project_name" {
  description = "Project name prefix for IAM resources"
  type        = string
}

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "tags" {
  description = "Tags applied to IAM resources"
  type        = map(string)
  default     = {}
}

variable "trusted_assumer_role_arns" {
  description = "IAM role ARNs allowed to call sts:AssumeRole on the KVS session credentials role (Session API + Relay Registry Lambda execution roles)"
  type        = list(string)
}
