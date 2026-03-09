# =============================================================================
# CUSTOM DOMAIN MODULE - CERTIFICATE ONLY 
# Configures Route53 hosted zone and SSL certificate (no ALB dependency)
# =============================================================================

# Route 53 Hosted Zone (if custom domain is enabled)
resource "aws_route53_zone" "main" {
  count = var.enable_custom_domain ? 1 : 0
  name  = var.domain_name

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-hosted-zone"
  })
}

# ACM Certificate for custom domain
# Skip if skip_certificate_creation is true (when using unified certificate)
resource "aws_acm_certificate" "main" {
  count       = var.enable_custom_domain && !var.skip_certificate_creation ? 1 : 0
  domain_name = var.domain_name
  subject_alternative_names = concat(
    ["*.${var.domain_name}"], # Always include wildcard for main domain
    var.additional_domains    # Include any additional domains (e.g., investcosine.com, *.investcosine.com)
  )
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-certificate"
  })
}

# Certificate validation records
# Only create if certificate is being created in this module
resource "aws_route53_record" "cert_validation" {
  for_each = var.enable_custom_domain && !var.skip_certificate_creation && length(aws_acm_certificate.main) > 0 ? {
    for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = aws_route53_zone.main[0].zone_id
}

# Certificate validation
# Only create if certificate is being created in this module
resource "aws_acm_certificate_validation" "main" {
  count                   = var.enable_custom_domain && !var.skip_certificate_creation && length(aws_acm_certificate.main) > 0 ? 1 : 0
  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
