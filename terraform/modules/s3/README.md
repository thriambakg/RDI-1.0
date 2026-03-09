# S3 Module

This module creates S3 buckets for frontend hosting and access logging with security best practices.

## Features

- Frontend S3 bucket with versioning and encryption
- Dedicated access logs bucket with versioning and encryption
- KMS encryption for all buckets
- Public access blocking
- Access logging configuration
- Proper ACLs and ownership controls

## Usage

```hcl
module "s3_buckets" {
  source = "./modules/s3"
  
  bucket_name      = "my-frontend-bucket"
  kms_key_arn      = aws_kms_key.main.arn
  enable_versioning = true
  log_prefix       = "access-logs/"
  
  tags = {
    Environment = "production"
    Project     = "my-project"
  }
}
```

## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.0 |
| aws | ~> 5.0 |

## Resources

| Name | Type |
|------|------|
| aws_s3_bucket.frontend | resource |
| aws_s3_bucket.logs | resource |
| aws_s3_bucket_acl.frontend | resource |
| aws_s3_bucket_acl.logs | resource |
| aws_s3_bucket_logging.frontend | resource |
| aws_s3_bucket_ownership_controls.frontend | resource |
| aws_s3_bucket_ownership_controls.logs | resource |
| aws_s3_bucket_public_access_block.frontend | resource |
| aws_s3_bucket_public_access_block.logs | resource |
| aws_s3_bucket_server_side_encryption_configuration.frontend | resource |
| aws_s3_bucket_server_side_encryption_configuration.logs | resource |
| aws_s3_bucket_versioning.frontend | resource |
| aws_s3_bucket_versioning.logs | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| bucket_name | Name of the S3 bucket | `string` | n/a | yes |
| kms_key_arn | ARN of the KMS key for encryption | `string` | n/a | yes |
| enable_versioning | Enable versioning on the S3 bucket | `bool` | `true` | no |
| log_prefix | Prefix for access log objects | `string` | `"access-logs/"` | no |
| tags | Common tags to apply to all resources | `map(string)` | `{}` | no |

## Outputs

| Name | Description |
|------|-------------|
| frontend_bucket_arn | ARN of the frontend S3 bucket |
| frontend_bucket_domain_name | Domain name of the frontend S3 bucket |
| frontend_bucket_id | ID of the frontend S3 bucket |
| frontend_bucket_regional_domain_name | Regional domain name of the frontend S3 bucket |
| logs_bucket_arn | ARN of the logs S3 bucket |
| logs_bucket_domain_name | Domain name of the logs S3 bucket |
| logs_bucket_id | ID of the logs S3 bucket |
