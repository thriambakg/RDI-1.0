variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_cidr" {
  type    = string
  default = "10.200.0.0/16"
}
variable "certificate_arn" {
  type    = string
  default = ""
}
variable "alb_idle_timeout_seconds" {
  type    = number
  default = 3600
}
variable "proxy_websocket_port" {
  type    = number
  default = 8765
}
variable "proxy_health_port" {
  type    = number
  default = 8766
}
variable "proxy_status_port" {
  type    = number
  default = 8767
}
variable "proxy_status_secret" {
  type      = string
  sensitive = true
}
variable "ecr_repository_url" { type = string }
variable "ecr_repository_arn" { type = string }
variable "cloudwatch_log_group_name" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}
