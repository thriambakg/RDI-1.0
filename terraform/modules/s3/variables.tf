# S3 Module Variables

variable "bucket_name" {
  description = "Name of the S3 bucket"
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

variable "enable_versioning" {
  description = "Enable versioning on the S3 bucket"
  type        = bool
  default     = true
}

variable "log_prefix" {
  description = "Prefix for access log objects"
  type        = string
  default     = "access-logs/"
}

variable "enable_website_hosting" {
  description = "Enable S3 website hosting"
  type        = bool
  default     = false
}

variable "index_document" {
  description = "Index document for website hosting"
  type        = string
  default     = "index.html"
}

variable "error_document" {
  description = "Error document for website hosting"
  type        = string
  default     = "error.html"
}

variable "enable_public_read" {
  description = "Enable public read access for website hosting"
  type        = bool
  default     = false
}
