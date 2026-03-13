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

# KMS key for layer artifacts encryption (per-region)
module "kms" {
  source = "./modules/kms"

  project_name = var.project_name
  environment  = var.environment
}

# S3 bucket for Lambda layer artifacts (per-region; same-region upload required for Lambda layers)
module "layer_artifacts_bucket" {
  source = "./modules/s3-bucket"

  bucket_name   = "${var.project_name}-lambda-layers-${var.environment}-${local.region}"
  environment   = var.environment
  purpose       = "lambda-layer-artifacts"
  kms_key_arn   = module.kms.main_key_arn
  force_destroy = false

  tags = {
    Type = "lambda-layers"
  }
}

# Core dependencies layer (boto3, requests, S3/DynamoDB, etc.)
module "core_layer" {
  source = "./modules/lambda-layer"

  project_name        = var.project_name
  environment         = var.environment
  layer_name_suffix   = "core"
  layer_description   = "Core dependencies (boto3, requests, S3, DynamoDB)"
  requirements_file   = "core-dependencies.txt"
  compatible_runtimes = ["python3.11", "python3.12"]
  s3_bucket_name      = module.layer_artifacts_bucket.bucket_id
  python_command      = "python3.11"

  depends_on = [module.layer_artifacts_bucket]
}

# Drone controls layer (MAVSDK for PX4/MAVLink)
module "drone_controls_layer" {
  source = "./modules/lambda-layer"

  project_name        = var.project_name
  environment         = var.environment
  layer_name_suffix   = "drone-controls"
  layer_description   = "MAVSDK for PX4/MAVLink drone control"
  requirements_file   = "drone-controls-dependencies.txt"
  compatible_runtimes = ["python3.11", "python3.12"]
  s3_bucket_name      = module.layer_artifacts_bucket.bucket_id
  python_command      = "python3.11"

  depends_on = [module.layer_artifacts_bucket]
}

output "core_layer_arn" {
  description = "ARN of the core Lambda layer"
  value       = module.core_layer.layer_arn
}

output "drone_controls_layer_arn" {
  description = "ARN of the drone-controls Lambda layer"
  value       = module.drone_controls_layer.layer_arn
}
