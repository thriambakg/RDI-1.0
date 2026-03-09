# =============================================================================
# DOMAIN MODULE VARIABLES - CERTIFICATE ONLY
# Variables for custom domain configuration and SSL certificate setup
# =============================================================================

variable "enable_custom_domain" {
  description = "Enable custom domain configuration with Route53 and SSL certificate"
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "The domain name for the application (e.g., example.com)"
  type        = string
  default     = ""
}

variable "subdomain" {
  description = "Subdomain for the application (e.g., app, staging, prod). Leave empty for root domain"
  type        = string
  default     = ""
}

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "additional_domains" {
  description = "Additional domains to include in the certificate (for unified certificates covering multiple domains)"
  type        = list(string)
  default     = []
}

variable "skip_certificate_creation" {
  description = "Skip certificate creation in this module (useful when using a unified certificate created elsewhere)"
  type        = bool
  default     = false
}