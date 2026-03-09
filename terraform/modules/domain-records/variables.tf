# =============================================================================
# DOMAIN RECORDS MODULE VARIABLES
# Variables for DNS records pointing to ALB
# =============================================================================

variable "enable_custom_domain" {
  description = "Enable custom domain configuration"
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "The domain name for the application (e.g., example.com)"
  type        = string
}

variable "subdomain" {
  description = "Subdomain for the application (e.g., app, staging, prod). Leave empty for root domain"
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID"
  type        = string
}

variable "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  type        = string
}

variable "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  type        = string
}
