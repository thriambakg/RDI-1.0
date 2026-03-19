output "vpc_id" { value = aws_vpc.proxy.id }
output "alb_dns_name" { value = aws_lb.proxy.dns_name }
output "alb_zone_id" { value = aws_lb.proxy.zone_id }
output "target_group_arn" { value = aws_lb_target_group.proxy.arn }
output "proxy_websocket_endpoint" {
  value = var.certificate_arn != "" ? "wss://${aws_lb.proxy.dns_name}" : "ws://${aws_lb.proxy.dns_name}:80"
}
output "session_status_url" {
  value = var.certificate_arn != "" ? "https://${aws_lb.proxy.dns_name}/session-status" : "http://${aws_lb.proxy.dns_name}/session-status"
}
