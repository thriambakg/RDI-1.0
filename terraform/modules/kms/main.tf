# KMS Module — single customer-managed key per stack.
# DynamoDB / CloudWatch use AWS-owned encryption in Base Infra; do not create unused CMKs.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_kms_key" "main" {
  description              = "Main KMS key for ${var.project_name} ${var.environment}"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = var.enable_key_rotation
  deletion_window_in_days  = var.deletion_window_in_days

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid    = "EnableRootAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      }],
      length(var.key_administrators) > 0 ? [{
        Sid    = "AllowKeyAdministrators"
        Effect = "Allow"
        Principal = {
          AWS = var.key_administrators
        }
        Action = [
          "kms:Create*",
          "kms:Describe*",
          "kms:Enable*",
          "kms:List*",
          "kms:Put*",
          "kms:Update*",
          "kms:Revoke*",
          "kms:Disable*",
          "kms:Get*",
          "kms:Delete*",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion"
        ]
        Resource = "*"
      }] : [],
      length(var.additional_role_arns) > 0 ? [{
        Sid    = "AllowAdditionalRoles"
        Effect = "Allow"
        Principal = {
          AWS = var.additional_role_arns
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
        }] : [], [
        {
          Sid    = "AllowServiceUsage"
          Effect = "Allow"
          Principal = {
            Service = var.allowed_services
          }
          Action = [
            "kms:Encrypt",
            "kms:Decrypt",
            "kms:ReEncrypt*",
            "kms:GenerateDataKey*",
            "kms:DescribeKey"
          ]
          Resource = "*"
        }
    ])
  })

  tags = merge(var.tags, {
    Name    = "${var.project_name}-main-key-${var.environment}"
    Type    = "KMSKey"
    Purpose = "GeneralEncryption"
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project_name}-main-${var.environment}"
  target_key_id = aws_kms_key.main.key_id
}

resource "aws_iam_policy" "kms_access_policy" {
  name        = var.region != "" ? "${var.project_name}-kms-access-policy-${var.environment}-${var.region}" : "${var.project_name}-kms-access-policy-${var.environment}"
  description = "IAM policy for accessing KMS keys"
  path        = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = [aws_kms_key.main.arn]
      }
    ]
  })

  tags = merge(var.tags, {
    Name    = var.region != "" ? "${var.project_name}-kms-access-policy-${var.environment}-${var.region}" : "${var.project_name}-kms-access-policy-${var.environment}"
    Type    = "IAMPolicy"
    Purpose = "KMSAccess"
  })
}
