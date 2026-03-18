output "vpc_id" {
  description = "Proxy VPC ID (base for subnets, ALB, proxy EC2)"
  value       = aws_vpc.proxy.id
}

output "vpc_cidr_block" {
  description = "Proxy VPC CIDR"
  value       = aws_vpc.proxy.cidr_block
}
