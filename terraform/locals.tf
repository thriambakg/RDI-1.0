# Shared locals (base state, region, session API / Lambda wiring)
locals {
  proxy_status_secret_value       = var.use_proxy_ecs && length(module.proxy_secrets) > 0 ? module.proxy_secrets[0].secret_values["proxy_status"]["value"] : random_password.proxy_status_secret.result
  is_primary_region               = var.primary_region != "" && var.region == var.primary_region
  region                          = data.aws_region.current.name
  base_state_key                  = var.base_state_key != "" ? var.base_state_key : "base-infra/${var.environment}/${var.region}/terraform.tfstate"
  connection_pool_tbl             = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.connection_pool_table_name : "rdi-connection-pool-${var.environment}"
  user_profiles_tbl               = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.user_profiles_table_name : "rdi-user-profiles-${var.environment}"
  relay_registry_tbl              = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.relay_registry_table_name : "rdi-relay-registry-${var.environment}"
  cognito_pool_arn                = var.base_state_bucket != "" ? "arn:aws:cognito-idp:${var.region}:${data.aws_caller_identity.current.account_id}:userpool/${data.terraform_remote_state.base[0].outputs.cognito_user_pool_id}" : ""
  api_gateway_cloudwatch_role_arn = var.base_state_bucket != "" ? data.terraform_remote_state.base[0].outputs.api_gateway_cloudwatch_role_arn : null

  # Certificate for ALB WSS: custom domain cert, or var.certificate_arn, or ssl_certificate module
  alb_certificate_arn = length(module.domain) > 0 && module.domain[0].certificate_arn != null ? module.domain[0].certificate_arn : (var.certificate_arn != "" ? var.certificate_arn : (length(module.ssl_certificate) > 0 ? module.ssl_certificate[0].certificate_arn : ""))

  # Session API proxy endpoint: custom domain wss:// when set, else proxy ECS
  proxy_endpoint = var.enable_custom_domain && var.domain_name != "" && var.subdomain != "" ? "wss://${var.subdomain}.${var.domain_name}" : (length(module.proxy_ecs) > 0 ? module.proxy_ecs[0].proxy_websocket_endpoint : "")

  # Lambda -> proxy session-status API. Prefer HTTPS via custom domain when available.
  proxy_status_url = length(module.proxy_ecs) > 0 ? (
    var.enable_custom_domain && var.domain_name != "" && var.subdomain != "" && local.alb_certificate_arn != "" ?
    "https://${var.subdomain}.${var.domain_name}/session-status" :
    module.proxy_ecs[0].session_status_url
  ) : ""
}
