# ECR Module Outputs
# modules/ecr/outputs.tf

output "repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.frontend.repository_url
}

output "repository_arn" {
  description = "ARN of the ECR repository"
  value       = aws_ecr_repository.frontend.arn
}

output "repository_name" {
  description = "Name of the ECR repository"
  value       = aws_ecr_repository.frontend.name
}
