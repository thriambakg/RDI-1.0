# ALB Module Variables
# modules/alb/variables.tf

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment (development, staging, production)"
  type        = string
}

variable "tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  description = "VPC ID where ALB will be deployed"
  type        = string
}

variable "public_subnet_ids" {
  description = "List of public subnet IDs for ALB"
  type        = list(string)
}

variable "certificate_arn" {
  description = "ARN of SSL certificate for HTTPS/WSS (required for HTTPS listener)"
  type        = string
}

variable "enable_https" {
  description = "Enable HTTPS listeners (requires certificate_arn when true)"
  type        = bool
  default     = false
}

variable "enable_deletion_protection" {
  description = "Enable deletion protection for ALB"
  type        = bool
  default     = false
}

variable "enable_access_logs" {
  description = "Enable access logs for ALB"
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "S3 bucket name for ALB access logs"
  type        = string
  default     = ""
}

variable "kms_key_arn" {
  description = "ARN of the KMS key for encryption"
  type        = string
}

variable "rate_limit" {
  description = "Rate limit for WAF (requests per 5 minutes)"
  type        = number
  default     = 2000
}

variable "blocked_countries" {
  description = "List of country codes to block"
  type        = list(string)
  default     = []
}

variable "enable_waf_logging" {
  description = "Enable WAF logging to CloudWatch"
  type        = bool
  default     = true
}

# WebSocket proxy target configuration (for RDI drone control)
variable "target_group_config" {
  description = "Target group configuration - port, target type, health check"
  type = object({
    port                = number
    target_type         = optional(string, "instance") # instance | ip
    health_check_path   = optional(string, "/")
    health_check_port   = optional(string, "traffic-port")
    healthy_threshold   = optional(number, 2)
    unhealthy_threshold = optional(number, 3)
    interval            = optional(number, 30)
    timeout             = optional(number, 5)
  })
  default = {
    port                = 3000
    target_type         = "ip"
    health_check_path   = "/api/health"
    health_check_port   = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 20
  }
}

variable "target_instance_ids" {
  description = "EC2 instance IDs for target group (when target_type=instance)"
  type        = list(string)
  default     = []
}

variable "deployment_trigger" {
  description = "Increment (e.g. in root variables.tf) to force replacement of ALB and target group"
  type        = string
  default     = "1"
}

variable "enable_waf" {
  description = "Enable WAF for the ALB"
  type        = bool
  default     = true
}
