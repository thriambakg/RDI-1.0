output "vpc_id" {
  description = "Proxy VPC ID (base for subnets, ALB, proxy EC2)"
  value       = aws_vpc.proxy.id
}

output "vpc_cidr_block" {
  description = "Proxy VPC CIDR"
  value       = aws_vpc.proxy.cidr_block
}

output "proxy_instance_id" {
  description = "Proxy EC2 instance ID (for SSM, pipeline)"
  value       = aws_instance.proxy.id
}

output "proxy_public_ip" {
  description = "Proxy public IP (EIP)"
  value       = aws_eip.proxy.public_ip
}

output "proxy_websocket_endpoint" {
  description = "WebSocket endpoint: wss:// when ALB+cert, else ws://EIP"
  value       = var.alb_subnet_cidr != "" && var.certificate_arn != "" ? "wss://${aws_lb.proxy[0].dns_name}" : "ws://${aws_eip.proxy.public_ip}:${var.proxy_websocket_port}"
}

output "alb_dns_name" {
  description = "ALB DNS name (when ALB enabled)"
  value       = var.alb_subnet_cidr != "" ? aws_lb.proxy[0].dns_name : null
}

output "alb_zone_id" {
  description = "ALB canonical zone ID (for Route53 alias)"
  value       = var.alb_subnet_cidr != "" ? aws_lb.proxy[0].zone_id : null
}

output "target_group_arn" {
  description = "Target group ARN for proxy WebSocket (pipeline health check)"
  value       = var.alb_subnet_cidr != "" ? aws_lb_target_group.proxy[0].arn : null
}
