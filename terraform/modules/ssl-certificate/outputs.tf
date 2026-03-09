# SSL Certificate Module Outputs
# modules/ssl-certificate/outputs.tf

output "certificate_arn" {
  description = "ARN of the ACM certificate"
  value       = aws_acm_certificate.main.arn
}

output "certificate_domain_name" {
  description = "Domain name of the certificate"
  value       = tls_self_signed_cert.main.cert_pem
}
