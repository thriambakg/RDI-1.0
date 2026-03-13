# Wavelength EC2 Module Outputs

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.wavelength.id
}

output "instance_private_ip" {
  description = "Private IP of the instance"
  value       = aws_instance.wavelength.private_ip
}

output "carrier_ip" {
  description = "Carrier (Elastic) IP - used for 5G device connectivity"
  value       = aws_eip.wavelength.public_ip
}

output "subnet_id" {
  description = "Wavelength subnet ID"
  value       = aws_subnet.wavelength.id
}

output "vpc_id" {
  description = "Wavelength VPC ID"
  value       = aws_vpc.wavelength.id
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.wavelength.id
}
