variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "region" {
  description = "AWS region for this deployment (each region gets its own state and resources)"
  type        = string
  default     = "us-east-1"
}

variable "regions" {
  description = "List of all regions to deploy to (for resources that need cross-region awareness)"
  type        = list(string)
  default     = []
}

variable "primary_region" {
  description = "Primary region for replication sources (S3, DynamoDB global tables, etc.)"
  type        = string
  default     = ""
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "rdi"
}

variable "wavelength_zone_id" {
  description = "Wavelength Zone ID for EC2 (e.g. use1-wl1-atl-wlz1). Empty = skip Wavelength deployment"
  type        = string
  default     = ""
}

variable "base_state_bucket" {
  description = "S3 bucket for base infra state (for reading connection pool, Cognito)"
  type        = string
  default     = ""
}

variable "base_state_key" {
  description = "S3 key for base infra state"
  type        = string
  default     = ""
}

variable "base_state_region" {
  description = "Region where base state bucket lives"
  type        = string
  default     = "eu-central-1"
}

variable "skip_proxy_build" {
  description = "Skip building and uploading the proxy binary (EC2 will use Python fallback). Set true when Rust is not available (e.g. terraform plan only)."
  type        = bool
  default     = false
}

