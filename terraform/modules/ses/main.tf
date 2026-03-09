# SES Module for email sending capabilities
# This module handles SES identity verification and configuration

# SES Identity (email address)
resource "aws_ses_email_identity" "from_email" {
  email = var.from_email
}

# SES Configuration Set for tracking (simplified)
resource "aws_ses_configuration_set" "main" {
  name = "${var.project_name}-ses-config-${var.environment}"

  delivery_options {
    tls_policy = "Optional"
  }

  reputation_metrics_enabled = true
}

# IAM Policy for Lambda functions to send emails via SES
resource "aws_iam_policy" "lambda_ses_policy" {
  name        = "${var.project_name}-lambda-ses-policy-${var.environment}"
  description = "Policy for Lambda functions to send emails via SES"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = [
          aws_ses_email_identity.from_email.arn
        ]
      }
    ]
  })

  tags = var.common_tags
}
