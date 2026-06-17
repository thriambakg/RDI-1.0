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

# Store proxy status secret in Secrets Manager (legacy WebSocket proxy only)
module "proxy_secrets" {
  source = "./modules/secrets-manager"
  count  = var.use_proxy_ecs ? 1 : 0

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

# ECR for proxy container (when using ECS)
resource "aws_ecr_repository" "proxy" {
  count                = var.use_proxy_ecs ? 1 : 0
  name                 = "${var.project_name}-proxy-${var.environment}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.kms.main_key_arn
  }
  tags = { Name = "${var.project_name}-proxy-ecr-${var.environment}" }
}

# Proxy ECS - Fargate proxy for WebSocket + session-status (replaces EC2)
module "proxy_ecs" {
  source = "./modules/proxy-ecs"
  count  = var.use_proxy_ecs ? 1 : 0

  project_name                    = var.project_name
  environment                     = var.environment
  vpc_cidr                        = "10.200.0.0/16"
  certificate_arn                 = local.alb_certificate_arn
  alb_idle_timeout_seconds        = 3600
  proxy_websocket_port            = 8765
  proxy_health_port               = 8766
  proxy_status_port               = 8767
  proxy_status_secret             = local.proxy_status_secret_value
  proxy_status_secret_arn         = module.proxy_secrets[0].secret_arns["proxy_status"]
  proxy_status_secret_kms_key_arn = module.kms.main_key_arn
  ecr_repository_url              = aws_ecr_repository.proxy[0].repository_url
  ecr_repository_arn              = aws_ecr_repository.proxy[0].arn
  cloudwatch_log_group_name       = "/rdi/${var.environment}/proxy"
  tags                            = {}
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

# Build proxy binary (Rust) - skip when using ECS or skip_proxy_build
resource "null_resource" "proxy_build" {
  count = var.use_proxy_ecs || var.skip_proxy_build ? 0 : 1

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

# Upload proxy binary to S3 for EC2 user_data to fetch (when not using ECS)
resource "aws_s3_object" "proxy_binary" {
  count = var.use_proxy_ecs || var.skip_proxy_build ? 0 : 1

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

# Upload agent binary to S3 (optional; relay-side builds skip via skip_agent_build). Not wired to edge EC2 in root stack.
resource "aws_s3_object" "agent_binary" {
  count = var.skip_agent_build ? 0 : 1

  bucket       = module.proxy_artifacts_bucket.bucket_id
  key          = "agent/rdi-agent"
  source       = "${path.module}/../src/agent/target/release/rdi-agent"
  content_type = "application/octet-stream"
  etag         = try(filemd5("${path.module}/../src/agent/target/release/rdi-agent"), "pending-build")

  depends_on = [null_resource.agent_build]
}

# -----------------------------------------------------------------------------
# KVS WebRTC data plane (IAM) — per-session signaling channels created at runtime
# -----------------------------------------------------------------------------
module "kvs_webrtc" {
  count  = var.base_state_bucket != "" && var.data_plane == "webrtc" ? 1 : 0
  source = "./modules/kvs-webrtc"

  project_name              = var.project_name
  environment               = var.environment
  trusted_assumer_role_arns = local.kvs_webrtc_trusted_assumer_role_arns
  tags                      = {}
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
    CONNECTION_POOL_TABLE   = local.connection_pool_tbl
    USER_PROFILES_TABLE     = local.user_profiles_tbl
    RELAY_REGISTRY_TABLE    = local.relay_registry_tbl
    PROXY_ENDPOINT          = local.proxy_endpoint
    PROXY_STATUS_URL        = local.proxy_status_url
    PROXY_STATUS_SECRET_ARN = var.use_proxy_ecs && length(module.proxy_secrets) > 0 ? module.proxy_secrets[0].secret_arns["proxy_status"] : ""
    MAVLINK_PORT            = tostring(var.mavlink_port)
    DATA_PLANE              = var.data_plane
    KVS_WEBRTC_ROLE_ARN     = length(module.kvs_webrtc) > 0 ? module.kvs_webrtc[0].session_role_arn : ""
  }

  additional_policy_arns = concat(
    [aws_iam_policy.session_api_dynamodb[0].arn],
    var.use_proxy_ecs && length(aws_iam_policy.session_api_proxy_secret) > 0 ? [aws_iam_policy.session_api_proxy_secret[0].arn] : [],
    length(module.kvs_webrtc) > 0 ? [module.kvs_webrtc[0].session_api_policy_arn] : []
  )
  depends_on = [aws_iam_policy.session_api_dynamodb]
  layers     = [module.core_layer.layer_arn]

  tags = {}
}

# Allow Session API Lambda to read proxy status secret from Secrets Manager (same source as proxy ECS)
resource "aws_iam_policy" "session_api_proxy_secret" {
  count       = var.use_proxy_ecs && length(module.proxy_secrets) > 0 ? 1 : 0
  name        = "${var.project_name}-session-api-proxy-secret-${var.environment}"
  description = "Read proxy status secret for session-status API (Lambda + proxy share same source)"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [module.proxy_secrets[0].secret_arns["proxy_status"]]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey"]
        Resource = [module.kms.main_key_arn]
      }
    ]
  })
}

resource "aws_iam_policy" "session_api_dynamodb" {
  count       = var.base_state_bucket != "" ? 1 : 0
  name        = "${var.project_name}-session-api-dynamodb-${var.environment}"
  description = "DynamoDB access for session API (connection pool, user profiles, relay registry)"

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
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = ["arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.relay_registry_tbl}"]
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

# Relay Registry API Lambda - POST/GET/PATCH/DELETE /relays
module "relay_registry_api_lambda" {
  count  = var.base_state_bucket != "" ? 1 : 0
  source = "./modules/lambda"

  function_name = "${var.project_name}-relay-registry-api-${var.environment}-${local.region}"
  description   = "Relay registry API - register and manage relay devices per deployment region"
  handler       = "lambda_function.lambda_handler"
  runtime       = "python3.12"
  timeout       = 10
  memory_size   = 128
  source_dir    = "${path.module}/../src/relay-registry-api"

  environment_variables = {
    RELAY_REGISTRY_TABLE = local.relay_registry_tbl
    USER_PROFILES_TABLE  = local.user_profiles_tbl
    KVS_WEBRTC_ROLE_ARN  = length(module.kvs_webrtc) > 0 ? module.kvs_webrtc[0].session_role_arn : ""
  }

  additional_policy_arns = concat(
    [aws_iam_policy.relay_registry_api_dynamodb[0].arn],
    [aws_iam_policy.relay_registry_api_user_profiles[0].arn],
    length(module.kvs_webrtc) > 0 ? [module.kvs_webrtc[0].relay_registry_api_policy_arn] : []
  )
  depends_on = [aws_iam_policy.relay_registry_api_dynamodb, aws_iam_policy.relay_registry_api_user_profiles]
  layers     = [module.core_layer.layer_arn]

  tags = {}
}

resource "aws_iam_policy" "relay_registry_api_dynamodb" {
  count       = var.base_state_bucket != "" ? 1 : 0
  name        = "${var.project_name}-relay-registry-api-dynamodb-${var.environment}"
  description = "DynamoDB access for relay registry API"

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
          "dynamodb:Query"
        ]
        Resource = [
          "arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.relay_registry_tbl}",
          "arn:aws:dynamodb:${local.region}:${data.aws_caller_identity.current.account_id}:table/${local.relay_registry_tbl}/index/*"
        ]
      }
    ]
  })
}

resource "aws_iam_policy" "relay_registry_api_user_profiles" {
  count       = var.base_state_bucket != "" ? 1 : 0
  name        = "${var.project_name}-relay-registry-api-user-profiles-${var.environment}"
  description = "User profiles access for relay registry API (sync relays to profile)"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:UpdateItem"
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
  # Per-method auth: announce/claim-status are NONE; user routes stay COGNITO_USER_POOLS
  force_cognito_authorization = false

  # Extensible: add new resources here (e.g. connections, folders) and corresponding methods
  resources = {
    sessions               = { path_part = "sessions" }
    user_profile           = { path_part = "user-profile" }
    relays                 = { path_part = "relays" }
    relays_claim           = { path_part = "claim", parent_resource_key = "relays" }
    relays_announce        = { path_part = "announce", parent_resource_key = "relays" }
    relays_claim_status    = { path_part = "claim-status", parent_resource_key = "relays" }
    relays_webrtc_master   = { path_part = "webrtc-master", parent_resource_key = "relays" }
    relays_active_sessions = { path_part = "active-sessions", parent_resource_key = "relays" }
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
    post_relays = {
      resource_key            = "relays"
      http_method             = "POST"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    get_relays = {
      resource_key            = "relays"
      http_method             = "GET"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    patch_relays = {
      resource_key            = "relays"
      http_method             = "PATCH"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    delete_relays = {
      resource_key            = "relays"
      http_method             = "DELETE"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    post_relays_claim = {
      resource_key            = "relays_claim"
      http_method             = "POST"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "COGNITO_USER_POOLS"
    }
    post_relays_announce = {
      resource_key            = "relays_announce"
      http_method             = "POST"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "NONE"
    }
    get_relays_claim_status = {
      resource_key            = "relays_claim_status"
      http_method             = "GET"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "NONE"
    }
    get_relays_webrtc_master = {
      resource_key            = "relays_webrtc_master"
      http_method             = "GET"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "NONE"
    }
    get_relays_active_sessions = {
      resource_key            = "relays_active_sessions"
      http_method             = "GET"
      integration_type        = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn              = module.relay_registry_api_lambda[0].function_arn
      authorization_type      = "NONE"
    }
  }

  lambda_permissions = {
    post                       = { function_arn = module.session_api_lambda[0].function_arn, http_method = "POST", resource_path = "sessions" }
    get                        = { function_arn = module.session_api_lambda[0].function_arn, http_method = "GET", resource_path = "sessions" }
    delete                     = { function_arn = module.session_api_lambda[0].function_arn, http_method = "DELETE", resource_path = "sessions" }
    patch                      = { function_arn = module.session_api_lambda[0].function_arn, http_method = "PATCH", resource_path = "sessions" }
    get_user_profile           = { function_arn = module.user_profile_api_lambda[0].function_arn, http_method = "GET", resource_path = "user-profile" }
    patch_user_profile         = { function_arn = module.user_profile_api_lambda[0].function_arn, http_method = "PATCH", resource_path = "user-profile" }
    post_relays                = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "POST", resource_path = "relays" }
    get_relays                 = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "GET", resource_path = "relays" }
    patch_relays               = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "PATCH", resource_path = "relays" }
    delete_relays              = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "DELETE", resource_path = "relays" }
    post_relays_claim          = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "POST", resource_path = "relays/claim" }
    post_relays_announce       = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "POST", resource_path = "relays/announce" }
    get_relays_claim_status    = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "GET", resource_path = "relays/claim-status" }
    get_relays_webrtc_master   = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "GET", resource_path = "relays/webrtc-master" }
    get_relays_active_sessions = { function_arn = module.relay_registry_api_lambda[0].function_arn, http_method = "GET", resource_path = "relays/active-sessions" }
  }

  deployment_trigger = "6"
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
  count = var.enable_custom_domain && var.domain_name != "" && var.subdomain != "" && var.enable_alb_wss && length(module.domain) > 0 && length(module.proxy_ecs) > 0 ? 1 : 0

  zone_id = module.domain[0].hosted_zone_id
  name    = "${var.subdomain}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = module.proxy_ecs[0].alb_dns_name
    zone_id                = module.proxy_ecs[0].alb_zone_id
    evaluate_target_health = false
  }
}
