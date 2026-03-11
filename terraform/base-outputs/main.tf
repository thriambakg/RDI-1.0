# Read base infrastructure outputs via remote state (no checkout of RDI-Base-Infra needed)
# Used by deploy-frontend workflow for S3 bucket, CloudFront ID, build env vars

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region = var.state_region
}

locals {
  base_region = var.environment == "staging" ? "us-east-2" : "eu-central-1"
  state_key   = "base-infra/${var.environment}/${local.base_region}/terraform.tfstate"
}

data "terraform_remote_state" "base" {
  backend = "s3"
  config = {
    bucket         = var.state_bucket
    key            = local.state_key
    region         = var.state_region
    dynamodb_table = var.state_dynamodb_table
    encrypt        = true
  }
}

output "frontend_s3_bucket_name" {
  description = "S3 bucket for frontend static hosting"
  value       = data.terraform_remote_state.base.outputs.frontend_s3_bucket_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for frontend"
  value       = data.terraform_remote_state.base.outputs.cloudfront_distribution_id
}

output "frontend_url" {
  description = "Frontend URL (CloudFront)"
  value       = data.terraform_remote_state.base.outputs.frontend_url
}

output "build_environment_variables" {
  description = "JSON object of build env vars for frontend"
  value       = data.terraform_remote_state.base.outputs.build_environment_variables
}
