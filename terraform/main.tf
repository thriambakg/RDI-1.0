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

# Secret for Lambda -> proxy session-status API (active/idle instructions)
resource "random_password" "proxy_status_secret" {
  length  = 32
  special = true
}

# Store proxy status secret in Secrets Manager so it stays stable (avoids Lambda/proxy drift when random_password is recreated)
module "proxy_secrets" {
  source = "./modules/secrets-manager"
  count  = 1

  project_name = var.project_name
  environment  = var.environment
  kms_key_id   = module.kms.main_key_arn
  tags         = {}

  secrets = {
    proxy_status = {
      description = "Secret for Lambda->proxy session-status API (X-Proxy-Secret)"
      secret_data = { "value" = coalesce(var.proxy_status_secret, random_password.proxy_status_secret.result) }
    }
  }
}

# RDI Edge - VPC, proxy EC2, ALB (WebSocket + session-status). All-in-one.
# Bump infra_version (e.g. 1 -> 2) to force replacement of edge resources.
module "rdi_edge" {
  source = "./modules/rdi-edge"
  count  = 1

  project_name                  = var.project_name
  environment                   = var.environment
  infra_version                 = 1
  vpc_cidr                      = "10.200.0.0/16"
  proxy_subnet_cidr             = var.proxy_subnet_cidr
  alb_subnet_cidr               = var.enable_alb_wss ? var.alb_subnet_cidr : ""
  certificate_arn               = local.alb_certificate_arn
  alb_idle_timeout_seconds      = 3600
  instance_type                 = "t3.small"
  root_volume_size              = 30
  key_name                      = ""
  kms_key_arn                   = module.kms.main_key_arn
  proxy_websocket_port          = 8765
  proxy_health_port             = 8766
  proxy_status_port             = 8767
  user_data                     = local.proxy_user_data
  proxy_binary_s3_bucket        = module.proxy_artifacts_bucket.bucket_id
  proxy_binary_s3_key           = "proxy/rdi-proxy"
  enable_s3_proxy_binary_access = true
  cloudwatch_log_group_name     = "/rdi/${var.environment}/proxy"
  tags                          = {}

  # Ensure proxy binary is in S3 before instance boots (user_data downloads it)
  depends_on = [aws_s3_object.proxy_binary]
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

# Ensure agent binary is in S3 before Wavelength boots (so user_data can fetch it).
# Use stable trigger (bucket+key) so plan doesn't change when S3 etag is computed during apply.
resource "null_resource" "wavelength_agent_ready" {
  count = var.wavelength_zone_id != "" && !var.skip_agent_build ? 1 : 0

  triggers = {
    agent_bucket = module.proxy_artifacts_bucket.bucket_id
    agent_key    = "agent/rdi-agent"
  }

  depends_on = [aws_s3_object.agent_binary]
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

# Build agent binary (Rust) - skip when skip_agent_build=true
resource "null_resource" "agent_build" {
  count = var.skip_agent_build ? 0 : 1

  triggers = {
    cargo_toml   = filemd5("${path.module}/../src/agent/Cargo.toml")
    main_rs      = filemd5("${path.module}/../src/agent/src/main.rs")
    build_script = filemd5("${path.module}/../scripts/build-agent.sh")
  }

  provisioner "local-exec" {
    command     = "bash ../scripts/build-agent.sh"
    working_dir = path.module
  }
}

# Upload agent binary to S3 for Wavelength EC2 user_data to fetch
resource "aws_s3_object" "agent_binary" {
  count = var.skip_agent_build ? 0 : 1

  bucket       = module.proxy_artifacts_bucket.bucket_id
  key          = "agent/rdi-agent"
  source       = "${path.module}/../src/agent/target/release/rdi-agent"
  content_type = "application/octet-stream"
  etag         = try(filemd5("${path.module}/../src/agent/target/release/rdi-agent"), "pending-build")

  depends_on = [null_resource.agent_build]
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

  environment_variables = merge({
    CONNECTION_POOL_TABLE = local.connection_pool_tbl
    USER_PROFILES_TABLE   = local.user_profiles_tbl
    PROXY_ENDPOINT        = local.proxy_endpoint
    PROXY_STATUS_URL      = local.proxy_status_url
    PROXY_STATUS_SECRET   = local.proxy_status_secret_value
  }, {})

  additional_policy_arns = concat(
    [aws_iam_policy.session_api_dynamodb[0].arn],
    length(aws_iam_policy.session_api_ssm) > 0 ? [aws_iam_policy.session_api_ssm[0].arn] : []
  )
  depends_on = [aws_iam_policy.session_api_dynamodb]
  layers     = [module.core_layer.layer_arn]

  tags = {}
}

# Allow Session API Lambda to start RDI agent on Wavelength instance via SSM (disabled when rdi_edge removed)
resource "aws_iam_policy" "session_api_ssm" {
  count       = 0
  name        = "${var.project_name}-session-api-ssm-${var.environment}"
  description = "SSM SendCommand to start agent on Wavelength EC2"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = ["arn:aws:ssm:${local.region}::document/AWS-RunShellScript"]
      }
    ]
  })
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
          "dynamodb:Scan",
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
  deployment_trigger = "1"
}

# Scheduled idle-expiry: mark sessions idle when idle_after has passed (no DynamoDB TTL delete)
resource "aws_cloudwatch_event_rule" "session_idle_expiry" {
  count               = var.base_state_bucket != "" ? 1 : 0
  name                = "${var.project_name}-session-idle-expiry-${var.environment}"
  description         = "Invoke Session API Lambda to mark TTL-expired sessions as idle (not delete)"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "session_idle_expiry" {
  count     = var.base_state_bucket != "" ? 1 : 0
  rule      = aws_cloudwatch_event_rule.session_idle_expiry[0].name
  target_id = "SessionApiIdleExpiry"
  arn       = module.session_api_lambda[0].function_arn
  input     = jsonencode({ "source" = "schedule", "action" = "idle_expired_sessions" })
}

resource "aws_lambda_permission" "session_idle_expiry" {
  count         = var.base_state_bucket != "" ? 1 : 0
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = module.session_api_lambda[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.session_idle_expiry[0].arn
}

# CloudWatch Log groups for proxy and agent (so you can see connection failures in CloudWatch). Always created so references are valid.
resource "aws_cloudwatch_log_group" "rdi_proxy" {
  name              = "/rdi/${var.environment}/proxy"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "rdi_agent" {
  name              = "/rdi/${var.environment}/agent"
  retention_in_days = 7
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

# Route53 ALB alias for WSS subdomain (wss.rdistaging.com -> ALB)
resource "aws_route53_record" "wss_alias" {
  count = var.enable_custom_domain && var.domain_name != "" && var.subdomain != "" && var.enable_alb_wss && var.alb_subnet_cidr != "" && length(module.domain) > 0 && length(module.rdi_edge) > 0 ? 1 : 0

  zone_id = module.domain[0].hosted_zone_id
  name    = "${var.subdomain}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = module.rdi_edge[0].alb_dns_name
    zone_id                = module.rdi_edge[0].alb_zone_id
    evaluate_target_health = false
  }
}
