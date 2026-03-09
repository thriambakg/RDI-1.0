# S3 Module Outputs

output "frontend_bucket_id" {
  description = "ID of the frontend S3 bucket"
  value       = aws_s3_bucket.frontend.id
}

output "frontend_bucket_arn" {
  description = "ARN of the frontend S3 bucket"
  value       = aws_s3_bucket.frontend.arn
}

output "frontend_bucket_domain_name" {
  description = "Domain name of the frontend S3 bucket"
  value       = aws_s3_bucket.frontend.bucket_domain_name
}

output "frontend_bucket_regional_domain_name" {
  description = "Regional domain name of the frontend S3 bucket"
  value       = aws_s3_bucket.frontend.bucket_regional_domain_name
}


output "logs_bucket_id" {
  description = "ID of the logs S3 bucket"
  value       = aws_s3_bucket.logs.id
}

output "logs_bucket_arn" {
  description = "ARN of the logs S3 bucket"
  value       = aws_s3_bucket.logs.arn
}

output "logs_bucket_domain_name" {
  description = "Domain name of the logs S3 bucket"
  value       = aws_s3_bucket.logs.bucket_domain_name
}

output "website_endpoint" {
  description = "Website endpoint of the frontend S3 bucket"
  value       = var.enable_website_hosting ? aws_s3_bucket_website_configuration.frontend[0].website_endpoint : null
}

output "website_domain" {
  description = "Website domain of the frontend S3 bucket"
  value       = var.enable_website_hosting ? aws_s3_bucket_website_configuration.frontend[0].website_domain : null
}
