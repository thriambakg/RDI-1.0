# =============================================================================
# DOMAIN MODULE OUTPUTS - CERTIFICATE ONLY
# Outputs for custom domain configuration and SSL certificate information
# =============================================================================

output "hosted_zone_id" {
  description = "Route53 hosted zone ID"
  value       = var.enable_custom_domain ? aws_route53_zone.main[0].zone_id : null
}

output "hosted_zone_name_servers" {
  description = "Route53 hosted zone name servers"
  value       = var.enable_custom_domain ? aws_route53_zone.main[0].name_servers : []
}

output "certificate_arn" {
  description = "ARN of the ACM certificate (null if skip_certificate_creation is true)"
  value       = var.enable_custom_domain && !var.skip_certificate_creation && length(aws_acm_certificate_validation.main) > 0 ? aws_acm_certificate_validation.main[0].certificate_arn : null
}

output "domain_name" {
  description = "Base domain name"
  value       = var.enable_custom_domain ? var.domain_name : null
}

output "full_domain_name" {
  description = "Full domain name for the application including subdomain"
  value       = var.enable_custom_domain ? (var.subdomain != "" ? "${var.subdomain}.${var.domain_name}" : var.domain_name) : null
}
