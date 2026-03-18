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
  description = "WebSocket endpoint (ws://...)"
  value       = "ws://${aws_eip.proxy.public_ip}:${var.proxy_websocket_port}"
}
