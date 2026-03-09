output "ses_email_identity_arn" {
  description = "ARN of the SES email identity"
  value       = aws_ses_email_identity.from_email.arn
}

output "ses_email_identity_email" {
  description = "Email address of the SES identity"
  value       = aws_ses_email_identity.from_email.email
}

output "ses_configuration_set_name" {
  description = "Name of the SES configuration set"
  value       = aws_ses_configuration_set.main.name
}

output "lambda_ses_policy_arn" {
  description = "ARN of the IAM policy for Lambda functions to send emails via SES"
  value       = aws_iam_policy.lambda_ses_policy.arn
}
