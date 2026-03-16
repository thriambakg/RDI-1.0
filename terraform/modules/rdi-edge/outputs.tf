# Outputs match root-level usage so callers can switch from separate modules to this bundle unchanged.

output "proxy_instance_id" {
  description = "Proxy EC2 instance ID (for SSM restart after deploy)"
  value       = length(module.proxy_ec2) > 0 ? module.proxy_ec2[0].instance_id : null
}

output "proxy_public_ip" {
  description = "Proxy public IP"
  value       = length(module.proxy_ec2) > 0 ? module.proxy_ec2[0].public_ip : null
}

output "proxy_websocket_endpoint_direct" {
  description = "WebSocket endpoint when using proxy directly (no ALB)"
  value       = length(module.proxy_ec2) > 0 ? module.proxy_ec2[0].websocket_endpoint : null
}

output "alb_dns_name" {
  description = "ALB DNS name (when ALB enabled)"
  value       = length(module.alb_websocket) > 0 ? module.alb_websocket[0].alb_dns_name : null
}

output "alb_zone_id" {
  description = "ALB zone ID (for Route53 alias)"
  value       = length(module.alb_websocket) > 0 ? module.alb_websocket[0].alb_zone_id : null
}

output "proxy_target_group_arn" {
  description = "Target group ARN for proxy (WebSocket ALB)"
  value       = length(module.alb_websocket) > 0 ? module.alb_websocket[0].target_group_arn : null
}

output "wavelength_instance_id" {
  description = "Wavelength EC2 instance ID (when deployed)"
  value       = length(module.wavelength_ec2) > 0 ? module.wavelength_ec2[0].instance_id : null
}

output "wavelength_carrier_ip" {
  description = "Wavelength carrier IP for 5G connectivity"
  value       = length(module.wavelength_ec2) > 0 ? module.wavelength_ec2[0].carrier_ip : null
}
