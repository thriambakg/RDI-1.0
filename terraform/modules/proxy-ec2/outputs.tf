output "instance_id" {
  description = "Proxy EC2 instance ID"
  value       = aws_instance.proxy.id
}

output "public_ip" {
  description = "Proxy public IP (stable via EIP)"
  value       = aws_eip.proxy.public_ip
}

output "websocket_endpoint" {
  description = "WebSocket endpoint for frontend and agent"
  value       = "ws://${aws_eip.proxy.public_ip}:${var.proxy_websocket_port}"
}

output "vpc_id" {
  description = "Proxy VPC ID"
  value       = aws_vpc.proxy.id
}

output "subnet_id" {
  description = "Proxy subnet ID"
  value       = aws_subnet.proxy.id
}
