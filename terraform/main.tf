# RDI Application Infrastructure
# Uses remote state in S3 - base infrastructure must be deployed first

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
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

# Required by s3-bucket module for optional cross-region replication (not used when replication disabled)
provider "aws" {
  alias  = "replica"
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

# Secret for Lambda -> proxy session-status API (active/idle instructions)
resource "random_password" "proxy_status_secret" {
  length  = 32
  special = true
}

locals {
  is_primary_region               = var.primary_region != "" && var.region == var.primary_region
  region                          = data.aws_region.current.name
  base_state_key                  = var.base_state_key != "" ? var.base_state_key : "base-infra/${var.environment}/${var.region}/terraform.tfstate"
  connection_pool_tbl             = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.connection_pool_table_name : "rdi-connection-pool-${var.environment}"
  user_profiles_tbl               = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.user_profiles_table_name : "rdi-user-profiles-${var.environment}"
  cognito_pool_arn                = var.base_state_bucket != "" ? "arn:aws:cognito-idp:${var.region}:${data.aws_caller_identity.current.account_id}:userpool/${data.terraform_remote_state.base[0].outputs.cognito_user_pool_id}" : ""
  api_gateway_cloudwatch_role_arn = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.api_gateway_cloudwatch_role_arn : null

  # Session API deployment trigger - bump to force API Gateway redeploy (CORS, config changes)
  session_api_deployment_trigger = "2" # Bumped for CORS: allow PATCH (user-profile)
}

data "terraform_remote_state" "base" {
  count = var.base_state_bucket != "" ? 1 : 0

  backend = "s3"
  config = {
    bucket         = var.base_state_bucket
    key            = local.base_state_key
    region         = var.base_state_region
    dynamodb_table = "rdi-terraform-locks"
    encrypt        = true
  }
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

# KMS keys - owned by RDI-1.0 (per-region; Base Infra uses default encryption, no customer keys)
module "kms" {
  source = "./modules/kms"

  project_name = var.project_name
  environment  = var.environment
  region       = local.region
}

# S3 bucket for Lambda layer artifacts (per-region; same-region upload required for Lambda layers)
module "layer_artifacts_bucket" {
  source = "./modules/s3-bucket"

  providers = {
    aws.replica = aws.replica
  }

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

output "core_layer_arn" {
  description = "ARN of the core Lambda layer"
  value       = module.core_layer.layer_arn
}

# Wavelength EC2 - PX4 SITL at carrier edge (optional, single zone for MVP)
module "wavelength_ec2" {
  count  = var.wavelength_zone_id != "" ? 1 : 0
  source = "./modules/wavelength-ec2"

  project_name          = var.project_name
  environment           = var.environment
  wavelength_zone_id    = var.wavelength_zone_id
  kms_key_arn           = module.kms.main_key_arn
  key_name              = "" # Use SSM Session Manager; or set to existing key name for SSH
  allowed_ssh_cidrs     = ["0.0.0.0/0"]
  allowed_mavlink_cidrs = ["0.0.0.0/0"]
  allowed_api_cidrs     = ["0.0.0.0/0"]
  mavlink_port          = var.mavlink_port
}

output "wavelength_instance_id" {
  description = "Wavelength EC2 instance ID (when deployed)"
  value       = length(module.wavelength_ec2) > 0 ? module.wavelength_ec2[0].instance_id : null
}

output "wavelength_carrier_ip" {
  description = "Wavelength carrier IP for 5G connectivity"
  value       = length(module.wavelength_ec2) > 0 ? module.wavelength_ec2[0].carrier_ip : null
}

# S3 bucket for proxy binary (per-region)
module "proxy_artifacts_bucket" {
  source = "./modules/s3-bucket"

  providers = {
    aws.replica = aws.replica
  }

  bucket_name   = "${var.project_name}-proxy-artifacts-${var.environment}-${local.region}"
  environment   = var.environment
  purpose       = "proxy-binary"
  kms_key_arn   = module.kms.main_key_arn
  force_destroy = var.environment != "production"

  tags = {
    Type = "proxy-artifacts"
  }
}

# Build proxy binary (Rust) - skip when skip_proxy_build=true or when Rust unavailable
resource "null_resource" "proxy_build" {
  count = var.skip_proxy_build ? 0 : 1

  triggers = {
    # Rebuild when proxy source changes
    cargo_toml   = filemd5("${path.module}/../src/proxy/Cargo.toml")
    main_rs      = filemd5("${path.module}/../src/proxy/src/main.rs")
    build_script = filemd5("${path.module}/../scripts/build-proxy.sh")
  }

  provisioner "local-exec" {
    command     = "bash ../scripts/build-proxy.sh"
    working_dir = path.module
  }
}

# Upload proxy binary to S3 for EC2 user_data to fetch
resource "aws_s3_object" "proxy_binary" {
  count = var.skip_proxy_build ? 0 : 1

  bucket       = module.proxy_artifacts_bucket.bucket_id
  key          = "proxy/rdi-proxy"
  source       = "${path.module}/../src/proxy/target/release/rdi-proxy"
  content_type = "application/octet-stream"
  # Use filemd5 when file exists (CI); placeholder avoids plan-time error when not yet built
  etag = try(filemd5("${path.module}/../src/proxy/target/release/rdi-proxy"), "pending-build")

  depends_on = [null_resource.proxy_build]
}

# Session API and Proxy - require base infra (connection pool, Cognito)
module "session_api_lambda" {
  count  = var.base_state_bucket != "" ? 1 : 0
  source = "./modules/lambda"

  function_name = "${var.project_name}-session-api-${var.environment}-${local.region}"
  description   = "Session/connection pool API for RDI"
  handler       = "lambda_function.lambda_handler"
  runtime       = "python3.12"
  timeout       = 15
  memory_size   = 128
  source_dir    = "${path.module}/../src/session-api"

  environment_variables = {
    CONNECTION_POOL_TABLE = local.connection_pool_tbl
    USER_PROFILES_TABLE   = local.user_profiles_tbl
    PROXY_ENDPOINT        = (var.enable_custom_domain && var.domain_name != "" && length(module.domain) > 0) ? "wss://${module.domain[0].full_domain_name}" : (length(module.alb_websocket) > 0 ? "wss://${module.alb_websocket[0].alb_dns_name}" : module.proxy_ec2.websocket_endpoint)
    PROXY_STATUS_URL      = "http://${module.proxy_ec2.public_ip}:8767/session-status"
    PROXY_STATUS_SECRET   = random_password.proxy_status_secret.result
  }

  additional_policy_arns = [aws_iam_policy.session_api_dynamodb[0].arn]
  depends_on             = [aws_iam_policy.session_api_dynamodb]
  layers                 = [module.core_layer.layer_arn]

  tags = {}
}

resource "aws_iam_policy" "session_api_dynamodb" {
  count       = var.base_state_bucket != "" ? 1 : 0
  name        = "${var.project_name}-session-api-dynamodb-${var.environment}"
  description = "DynamoDB access for session API (connection pool + user profiles)"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:BatchGetItem"
        ]
        Resource = [
          "arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.connection_pool_tbl}",
          "arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.connection_pool_tbl}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = [
          "arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.user_profiles_tbl}"
        ]
      }
    ]
  })
}

# User Profile API Lambda - GET /user-profile (folders/hierarchy)
module "user_profile_api_lambda" {
  count  = var.base_state_bucket != "" ? 1 : 0
  source = "./modules/lambda"

  function_name = "${var.project_name}-user-profile-api-${var.environment}-${local.region}"
  description   = "User profile API - returns connection hierarchy (folders)"
  handler       = "lambda_function.lambda_handler"
  runtime       = "python3.12"
  timeout       = 10
  memory_size   = 128
  source_dir    = "${path.module}/../src/user-profile-api"

  environment_variables = {
    USER_PROFILES_TABLE = local.user_profiles_tbl
  }

  additional_policy_arns = [aws_iam_policy.user_profile_api_dynamodb[0].arn]
  depends_on             = [aws_iam_policy.user_profile_api_dynamodb]
  layers                 = [module.core_layer.layer_arn]

  tags = {}
}

resource "aws_iam_policy" "user_profile_api_dynamodb" {
  count       = var.base_state_bucket != "" ? 1 : 0
  name        = "${var.project_name}-user-profile-api-dynamodb-${var.environment}"
  description = "DynamoDB access for user profile API"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = [
          "arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.user_profiles_tbl}"
        ]
      }
    ]
  })
}

# API Gateway account settings - CloudWatch execution logging (per-region; uses role from base infra)
resource "aws_api_gateway_account" "this" {
  count = var.base_state_bucket != "" && local.api_gateway_cloudwatch_role_arn != null ? 1 : 0

  cloudwatch_role_arn = local.api_gateway_cloudwatch_role_arn
}

# Session API Gateway
module "session_api" {
  count  = var.base_state_bucket != "" ? 1 : 0
  source = "./modules/api-gateway"

  depends_on = [aws_api_gateway_account.this]

  api_name              = "${var.project_name}-session-api-${var.environment}"
  api_description       = "RDI Session API for connection pool"
  stage_name            = "production"
  cognito_user_pool_arn = local.cognito_pool_arn

  # Extensible: add new resources here (e.g. connections, folders) and corresponding methods
  resources = {
    sessions     = { path_part = "sessions" }
    user_profile = { path_part = "user-profile" }
  }

  methods = {
    post_sessions = {
      resource_key            = "sessions"
      http_method             = "POST"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.session_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    get_sessions = {
      resource_key            = "sessions"
      http_method             = "GET"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.session_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    delete_sessions = {
      resource_key            = "sessions"
      http_method             = "DELETE"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.session_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    patch_sessions = {
      resource_key            = "sessions"
      http_method             = "PATCH"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.session_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    get_user_profile = {
      resource_key            = "user_profile"
      http_method             = "GET"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.user_profile_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    patch_user_profile = {
      resource_key            = "user_profile"
      http_method             = "PATCH"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.user_profile_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
  }

  lambda_permissions = {
    post               = { function_arn = module.session_api_lambda[0].function_arn, http_method = "POST", resource_path = "sessions" }
    get                = { function_arn = module.session_api_lambda[0].function_arn, http_method = "GET", resource_path = "sessions" }
    delete             = { function_arn = module.session_api_lambda[0].function_arn, http_method = "DELETE", resource_path = "sessions" }
    patch              = { function_arn = module.session_api_lambda[0].function_arn, http_method = "PATCH", resource_path = "sessions" }
    get_user_profile   = { function_arn = module.user_profile_api_lambda[0].function_arn, http_method = "GET", resource_path = "user-profile" }
    patch_user_profile = { function_arn = module.user_profile_api_lambda[0].function_arn, http_method = "PATCH", resource_path = "user-profile" }
  }

  # Combine Lambda hash (auto) with manual trigger (bump local.session_api_deployment_trigger to force redeploy)
  deployment_trigger = "${module.session_api_lambda[0].source_code_hash}-${module.user_profile_api_lambda[0].source_code_hash}-${local.session_api_deployment_trigger}"
}

# Proxy EC2 - depends on binary in S3 so user_data can fetch it at boot
module "proxy_ec2" {
  source = "./modules/proxy-ec2"

  project_name                  = var.project_name
  environment                   = var.environment
  kms_key_arn                   = module.kms.main_key_arn
  proxy_websocket_port          = 8765
  proxy_health_port             = 8766
  proxy_status_port             = 8767
  proxy_binary_s3_bucket        = module.proxy_artifacts_bucket.bucket_id
  proxy_binary_s3_key           = "proxy/rdi-proxy"
  enable_s3_proxy_binary_access = true
  proxy_subnet_cidr             = var.proxy_subnet_cidr
  alb_subnet_cidr               = var.enable_alb_wss ? var.alb_subnet_cidr : ""

  user_data = base64encode(templatefile("${path.module}/../src/proxy/user_data.sh", {
    s3_bucket     = module.proxy_artifacts_bucket.bucket_id
    s3_key        = "proxy/rdi-proxy"
    ws_port       = 8765
    status_port   = 8767
    status_secret = random_password.proxy_status_secret.result
  }))

  depends_on = [aws_s3_object.proxy_binary]

  tags = {}
}

# Custom domain: Route53 hosted zone + ACM DNS-validated cert (trusted in all browsers and on phones)
module "domain" {
  count  = var.enable_custom_domain && var.domain_name != "" ? 1 : 0
  source = "./modules/domain"

  enable_custom_domain = true
  domain_name          = var.domain_name
  subdomain            = var.subdomain
  project_name         = var.project_name
  environment          = var.environment
  common_tags          = {}
}

# SSL certificate for ALB WSS (self-signed for staging when no custom domain and no cert provided)
module "ssl_certificate" {
  count  = var.enable_alb_wss && var.certificate_arn == "" && !(var.enable_custom_domain && var.domain_name != "") ? 1 : 0
  source = "./modules/ssl-certificate"

  project_name = var.project_name
  environment  = var.environment
  aws_region   = local.region
  tags         = {}
}

# ALB for WSS (TLS termination) - targets Proxy EC2
module "alb_websocket" {
  count  = var.enable_alb_wss && var.alb_subnet_cidr != "" ? 1 : 0
  source = "./modules/alb"

  project_name       = var.project_name
  environment        = var.environment
  vpc_id             = module.proxy_ec2.vpc_id
  public_subnet_ids  = module.proxy_ec2.alb_subnet_ids
  certificate_arn    = (var.enable_custom_domain && var.domain_name != "" && length(module.domain) > 0) ? module.domain[0].certificate_arn : (var.certificate_arn != "" ? var.certificate_arn : module.ssl_certificate[0].certificate_arn)
  kms_key_arn        = module.kms.main_key_arn
  enable_waf         = false # WebSocket: skip WAF for lower latency and cost
  access_logs_bucket = ""
  enable_access_logs = false

  target_group_config = {
    port                = 8765
    target_type         = "instance"
    health_check_path   = "/"
    health_check_port   = "8766"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
  target_instance_ids = [module.proxy_ec2.instance_id]

  depends_on = [module.proxy_ec2]
  tags       = {}
}

# Point custom domain at the ALB so WSS is reachable at wss://<full_domain_name> with a trusted cert
resource "aws_route53_record" "alb_wss" {
  count   = var.enable_custom_domain && var.domain_name != "" && length(module.domain) > 0 && length(module.alb_websocket) > 0 ? 1 : 0
  zone_id = module.domain[0].hosted_zone_id
  name    = var.subdomain != "" ? "${var.subdomain}.${var.domain_name}" : var.domain_name
  type    = "A"

  alias {
    name                   = module.alb_websocket[0].alb_dns_name
    zone_id                = module.alb_websocket[0].alb_zone_id
    evaluate_target_health = true
  }
}

output "session_api_url" {
  description = "Full URL to the sessions resource (for testing)"
  value       = length(module.session_api) > 0 ? "${module.session_api[0].stage_url}sessions" : null
}

output "api_gateway_base_url" {
  description = "Base URL for Session API and User Profile API (use as API_GATEWAY_URL / VITE_API_GATEWAY_URL in frontend)"
  value       = length(module.session_api) > 0 ? module.session_api[0].stage_url : null
}

output "proxy_public_ip" {
  value = module.proxy_ec2.public_ip
}

output "proxy_websocket_endpoint" {
  description = "WebSocket endpoint (wss when ALB enabled; use custom domain when enable_custom_domain is set)"
  value       = (var.enable_custom_domain && var.domain_name != "" && length(module.domain) > 0) ? "wss://${module.domain[0].full_domain_name}" : (length(module.alb_websocket) > 0 ? "wss://${module.alb_websocket[0].alb_dns_name}" : module.proxy_ec2.websocket_endpoint)
}

output "wss_custom_domain_name_servers" {
  description = "Route53 name servers for domain_name; set these as NS at your registrar when enable_custom_domain is true"
  value       = var.enable_custom_domain && var.domain_name != "" && length(module.domain) > 0 ? module.domain[0].hosted_zone_name_servers : null
}

output "alb_dns_name" {
  description = "ALB DNS name (when ALB enabled)"
  value       = length(module.alb_websocket) > 0 ? module.alb_websocket[0].alb_dns_name : null
}

output "edge_zone_ids" {
  description = "Wavelength zone IDs available in this environment (for UI Edge Location selector)"
  value       = var.edge_zone_ids
}

