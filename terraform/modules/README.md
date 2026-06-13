# Terraform Modules

This directory contains reusable Terraform modules for the Cosine2.0 project.

## Available Modules

### CloudFront Module (`./cloudfront`)
- CloudFront distribution with S3 origin
- Origin Access Control (OAC) for secure S3 access
- Custom error pages and caching configurations

### KVS WebRTC Module (`./kvs-webrtc`)
- IAM role + policies for WebRTC signaling (per-session channels created at runtime by Session API)
- Replaces deprecated ECS `rdi-proxy` data plane when `data_plane = "webrtc"`

### Lambda Module (`./lambda`)
- AWS Lambda function with IAM roles
- CloudWatch logging with KMS encryption
- X-Ray tracing support
- API Gateway integration permissions

### S3 Module (`./s3`)
- Frontend S3 bucket with versioning and encryption
- Dedicated access logs bucket
- Security best practices (public access blocking, KMS encryption)
- Access logging configuration

## Usage

Each module contains its own README.md with detailed usage instructions, input variables, and outputs.

## Module Structure

Each module follows the standard Terraform module structure:
- `main.tf` - Primary resources
- `variables.tf` - Input variables
- `outputs.tf` - Output values
- `README.md` - Documentation and usage examples