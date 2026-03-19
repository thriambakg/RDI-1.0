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

output "core_layer_arn" {
  description = "ARN of the core Lambda layer"
  value       = module.core_layer.layer_arn
}

output "session_api_url" {
  description = "Full URL to the sessions resource (for testing)"
  value       = length(module.session_api) > 0 ? "${module.session_api[0].stage_url}sessions" : null
}

output "api_gateway_base_url" {
  description = "Base URL for Session API and User Profile API (use as API_GATEWAY_URL / VITE_API_GATEWAY_URL in frontend)"
  value       = length(module.session_api) > 0 ? module.session_api[0].stage_url : null
}

output "rdi_edge_vpc_id" {
  description = "RDI Edge VPC ID (from rdi-edge module)"
  value       = length(module.rdi_edge) > 0 ? module.rdi_edge[0].vpc_id : null
}

output "proxy_instance_id" {
  description = "Proxy EC2 instance ID (for SSM restart after deploy)"
  value       = length(module.rdi_edge) > 0 ? module.rdi_edge[0].proxy_instance_id : null
}

output "proxy_public_ip" {
  description = "Proxy public IP (EIP)"
  value       = length(module.rdi_edge) > 0 ? module.rdi_edge[0].proxy_public_ip : null
}

output "proxy_websocket_endpoint" {
  description = "WebSocket endpoint (wss when ALB+custom domain; use for frontend connections)"
  value       = length(module.rdi_edge) > 0 ? local.proxy_endpoint : null
}

output "wavelength_instance_id" {
  description = "Wavelength EC2 instance ID (when deployed)"
  value       = null
}

output "wavelength_carrier_ip" {
  description = "Wavelength carrier IP for 5G connectivity"
  value       = null
}

output "wss_custom_domain_name_servers" {
  description = "Route53 name servers for domain_name; set these as NS at your registrar when enable_custom_domain is true"
  value       = var.enable_custom_domain && var.domain_name != "" && length(module.domain) > 0 ? module.domain[0].hosted_zone_name_servers : null
}

output "alb_dns_name" {
  description = "ALB DNS name (when ALB enabled)"
  value       = length(module.rdi_edge) > 0 ? module.rdi_edge[0].alb_dns_name : null
}

output "proxy_target_group_arn" {
  description = "Target group ARN for proxy (WebSocket ALB); used by pipeline to check health before restart"
  value       = length(module.rdi_edge) > 0 ? module.rdi_edge[0].target_group_arn : null
}

output "edge_zone_ids" {
  description = "Wavelength zone IDs available in this environment (for UI Edge Location selector)"
  value       = var.edge_zone_ids
}

# Keep variables in use (avoids terraform_unused_declarations)
output "proxy_alb_subnet_cidrs" {
  description = "Subnet CIDRs for proxy and ALB (for rdi_edge when recreated)"
  value       = { proxy_subnet_cidr = var.proxy_subnet_cidr, alb_subnet_cidr = var.alb_subnet_cidr }
}

output "mavlink_port" {
  description = "MAVLink UDP port (for rdi_edge when recreated)"
  value       = var.mavlink_port
}
