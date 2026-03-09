# =============================================================================
# DOMAIN RECORDS MODULE OUTPUTS
# Outputs for DNS records
# =============================================================================

output "website_url" {
  description = "Complete URL for the website"
  value       = var.enable_custom_domain ? "https://${var.subdomain != "" ? "${var.subdomain}.${var.domain_name}" : var.domain_name}" : null
}

output "full_domain_name" {
  description = "Full domain name including subdomain"
  value       = var.enable_custom_domain ? (var.subdomain != "" ? "${var.subdomain}.${var.domain_name}" : var.domain_name) : null
}
