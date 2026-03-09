# =============================================================================
# DOMAIN RECORDS MODULE
# Creates DNS A records pointing to ALB (depends on ALB being created)
# =============================================================================

# A record pointing to ALB
resource "aws_route53_record" "frontend" {
  count   = var.enable_custom_domain ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = var.subdomain != "" ? "${var.subdomain}.${var.domain_name}" : var.domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

# CNAME record for www (if subdomain is not www)
resource "aws_route53_record" "www" {
  count   = var.enable_custom_domain && var.subdomain != "www" ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = "www.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = [var.subdomain != "" ? "${var.subdomain}.${var.domain_name}" : var.domain_name]
}
