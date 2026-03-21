# ALB Module Outputs
# modules/alb/outputs.tf

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = aws_lb.main.arn
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  value       = aws_lb.main.zone_id
}

output "target_group_arn" {
  description = "ARN of the target group"
  value       = aws_lb_target_group.main.arn
}

output "security_group_id" {
  description = "ID of the ALB security group"
  value       = aws_security_group.alb.id
}

output "waf_arn" {
  description = "ARN of the WAF Web ACL"
  value       = var.enable_waf ? aws_wafv2_web_acl.main[0].arn : null
}

output "waf_id" {
  description = "ID of the WAF Web ACL"
  value       = var.enable_waf ? aws_wafv2_web_acl.main[0].id : null
}

output "listener_arn" {
  description = "ARN of the ALB listener (HTTPS if certificate available, HTTP otherwise)"
  value       = var.certificate_arn != "" ? aws_lb_listener.https.arn : aws_lb_listener.http[0].arn
}

output "alb_ready" {
  description = "Null resource indicating ALB is fully ready"
  value       = null_resource.alb_ready_with_https[0].id
}
