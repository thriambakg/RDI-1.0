# SSL Certificate Module for Application Load Balancer  
# modules/ssl-certificate/main.tf
# Creates a self-signed certificate for ALB HTTPS support

# Generate a private key
resource "tls_private_key" "main" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

# Create a self-signed certificate
resource "tls_self_signed_cert" "main" {
  private_key_pem = tls_private_key.main.private_key_pem

  subject {
    common_name  = "*.us-east-1.elb.amazonaws.com"
    organization = "${var.project_name} Staging"
  }

  validity_period_hours = 8760 # 1 year

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]

  # Add ALB-compatible DNS names
  dns_names = [
    "*.us-east-1.elb.amazonaws.com",
    "*.elb.amazonaws.com",
    "staging.${var.project_name}.internal"
  ]
}

# Import the self-signed certificate to AWS Certificate Manager
resource "aws_acm_certificate" "main" {
  private_key      = tls_private_key.main.private_key_pem
  certificate_body = tls_self_signed_cert.main.cert_pem

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name    = "${var.project_name}-staging-certificate-${var.environment}"
    Type    = "self-signed"
    Purpose = "staging-https-oauth"
  })
}
