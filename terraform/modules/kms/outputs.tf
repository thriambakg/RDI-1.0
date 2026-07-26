# KMS Module Outputs

output "main_key_id" {
  description = "ID of the main KMS key"
  value       = aws_kms_key.main.key_id
}

output "main_key_arn" {
  description = "ARN of the main KMS key"
  value       = aws_kms_key.main.arn
}

output "main_key_alias" {
  description = "Alias of the main KMS key"
  value       = aws_kms_alias.main.name
}

output "all_key_ids" {
  description = "Map of all KMS key IDs"
  value = {
    main = aws_kms_key.main.key_id
  }
}

output "all_key_arns" {
  description = "Map of all KMS key ARNs"
  value = {
    main = aws_kms_key.main.arn
  }
}

output "kms_access_policy_arn" {
  description = "ARN of the IAM policy for accessing KMS keys"
  value       = aws_iam_policy.kms_access_policy.arn
}
