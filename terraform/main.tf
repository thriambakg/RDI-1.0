# RDI Application Infrastructure
# Uses remote state in S3 - base infrastructure must be deployed first

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    # Values from backend-configs/{env}-{region}.tfbackend
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "rdi-application"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  is_primary_region = var.primary_region != "" && var.region == var.primary_region
  region            = data.aws_region.current.name
  name_prefix       = "rdi-${var.environment}"
}

module "frontend" {
  source = "./modules/frontend"

  name_prefix = local.name_prefix
  environment = var.environment
  region      = var.region
  tags        = {}
}


output "account_id" {
  description = "Current AWS account ID"
  value       = data.aws_caller_identity.current.account_id
}

output "region" {
  description = "Deployed region"
  value       = local.region
}

output "is_primary_region" {
  description = "Whether this is the primary region"
  value       = local.is_primary_region
}

output "regions" {
  description = "All deployment regions"
  value       = var.regions
}

output "frontend_s3_bucket_name" {
  value = module.frontend.s3_bucket_name
}

output "cloudfront_distribution_id" {
  value = module.frontend.cloudfront_distribution_id
}

output "frontend_url" {
  value = module.frontend.frontend_url
}

output "build_environment_variables" {
  description = "JSON for frontend build (Cognito from base infra)"
  value = jsonencode({
    NEXT_PUBLIC_AWS_REGION                  = local.region
    NEXT_PUBLIC_COGNITO_USER_POOL_ID        = var.cognito_user_pool_id
    NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID = var.cognito_client_id
    NEXT_PUBLIC_COGNITO_DOMAIN              = var.cognito_domain
    NEXT_PUBLIC_REDIRECT_SIGN_IN            = "${module.frontend.frontend_url}/auth/callback"
    NEXT_PUBLIC_REDIRECT_SIGN_OUT           = module.frontend.frontend_url
    NEXT_PUBLIC_API_GATEWAY_URL             = ""
  })
}

output "websocket_api" {
  description = "WebSocket placeholder (Wavelength in future)"
  value = jsonencode({
    stage_url = ""
  })
}
