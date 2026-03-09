variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (staging, production, etc.)"
  type        = string
}

variable "from_email" {
  description = "Email address to send alerts from (must be verified in SES)"
  type        = string
}

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}
