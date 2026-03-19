# Proxy user_data: install from S3, run proxy, ship logs to CloudWatch (template from src/proxy/user_data.sh)
locals {
  proxy_user_data = templatefile("${path.module}/../src/proxy/user_data.sh", {
    infra_version        = 1
    ws_port              = 8765
    health_port          = 8766
    status_port          = 8767
    status_secret        = local.proxy_status_secret_value
    s3_bucket            = module.proxy_artifacts_bucket.bucket_id
    s3_key               = "proxy/rdi-proxy"
    cloudwatch_log_group = "/rdi/${var.environment}/proxy"
  })
}

# Shared locals (base state, region, session API / Lambda wiring)
locals {
  proxy_status_secret_value       = length(module.proxy_secrets) > 0 ? module.proxy_secrets[0].secret_values["proxy_status"]["value"] : random_password.proxy_status_secret.result
  is_primary_region               = var.primary_region != "" && var.region == var.primary_region
  region                          = data.aws_region.current.name
  base_state_key                  = var.base_state_key != "" ? var.base_state_key : "base-infra/${var.environment}/${var.region}/terraform.tfstate"
  connection_pool_tbl             = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.connection_pool_table_name : "rdi-connection-pool-${var.environment}"
  user_profiles_tbl               = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.user_profiles_table_name : "rdi-user-profiles-${var.environment}"
  cognito_pool_arn                = var.base_state_bucket != "" ? "arn:aws:cognito-idp:${var.region}:${data.aws_caller_identity.current.account_id}:userpool/${data.terraform_remote_state.base[0].outputs.cognito_user_pool_id}" : ""
  api_gateway_cloudwatch_role_arn = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.api_gateway_cloudwatch_role_arn : null
}
