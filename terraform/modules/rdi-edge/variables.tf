# RDI Edge bundle: Proxy EC2 + ALB (WebSocket) + Wavelength EC2.
# Variables match the previous root-level module inputs so behavior is unchanged.

variable "project_name" {
  type        = string
  description = "Project name for resource naming"
}

variable "environment" {
  type        = string
  description = "Environment (staging, production)"
}

variable "region" {
  type        = string
  description = "AWS region (for user_data template)"
}

variable "infra_version" {
  type        = number
  description = "Version number for proxy/ALB/Wavelength; 0 = none, >= 1 = create"
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for EBS and ALB"
}

variable "proxy_status_secret" {
  type        = string
  sensitive   = true
  description = "Secret for Lambda -> proxy session-status API"
}

# Proxy EC2
variable "proxy_subnet_cidr" {
  type        = string
  description = "CIDR for proxy EC2 subnet"
}

variable "alb_subnet_cidr" {
  type        = string
  description = "CIDR for ALB subnet (empty = no ALB)"
  default     = ""
}

variable "proxy_artifacts_bucket_id" {
  type        = string
  description = "S3 bucket ID for proxy binary"
}

variable "proxy_binary_s3_key" {
  type        = string
  default     = "proxy/rdi-proxy"
  description = "S3 key for proxy binary"
}

variable "cloudwatch_log_group_proxy" {
  type        = string
  description = "CloudWatch log group name for proxy"
}

# ALB (WebSocket)
variable "enable_alb_wss" {
  type        = bool
  description = "Enable ALB for WebSocket (TLS termination)"
  default     = true
}

variable "certificate_arn" {
  type        = string
  description = "ARN of SSL certificate for ALB HTTPS"
  default     = ""
}

# Wavelength EC2
variable "wavelength_zone_id" {
  type        = string
  description = "Wavelength Zone ID; empty = skip Wavelength"
  default     = ""
}

variable "mavlink_port" {
  type        = number
  description = "MAVLink UDP port for PX4"
  default     = 18570
}

variable "agent_binary_s3_bucket" {
  type        = string
  description = "S3 bucket for agent binary (when Wavelength enabled)"
  default     = ""
}

variable "agent_binary_s3_key" {
  type        = string
  default     = "agent/rdi-agent"
  description = "S3 key for agent binary"
}

variable "enable_agent_binary_s3_access" {
  type        = bool
  description = "Enable Wavelength instance to download agent from S3"
  default     = false
}

variable "cloudwatch_log_group_agent" {
  type        = string
  description = "CloudWatch log group name for agent"
  default     = ""
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags for resources"
}
