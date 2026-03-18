# RDI Edge - variables (inlined from proxy-ec2/alb/wavelength-ec2; no submodules).
# Only recreate resources when this module's .tf files change or when infra_version is bumped.

variable "project_name" {
  type        = string
  description = "Project name for resource naming"
}

variable "environment" {
  type        = string
  description = "Environment (staging, production)"
}

# Bump this value (e.g. 6 -> 7) and apply to force replacement of edge resources. Leave unchanged for normal applies.
variable "infra_version" {
  type        = number
  description = "Version for proxy/ALB/Wavelength. Bump to force recreate; keep stable to avoid replacements."
  default     = 1
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR for the proxy VPC (everything lives in this VPC except Wavelength)"
  default     = "10.200.0.0/16"
}

# --- Proxy EC2 ---
variable "proxy_subnet_cidr" {
  type        = string
  description = "CIDR for proxy subnet (within vpc_cidr)"
}

variable "instance_type" {
  type        = string
  description = "Proxy EC2 instance type"
  default     = "t3.small"
}

variable "root_volume_size" {
  type        = number
  description = "Root EBS volume size in GB (AL2023 >= 30)"
  default     = 30
}

variable "key_name" {
  type        = string
  description = "Existing EC2 key pair name (optional)"
  default     = ""
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for EBS encryption"
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

variable "allowed_cidrs" {
  type        = list(string)
  description = "CIDR blocks allowed for proxy traffic"
  default     = ["0.0.0.0/0"]
}

variable "allowed_ssh_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "user_data" {
  type        = string
  description = "User data script for proxy EC2 (install + run proxy, CloudWatch)"
  default     = ""
}

variable "proxy_binary_s3_bucket" {
  type        = string
  description = "S3 bucket containing proxy binary"
  default     = ""
}

variable "proxy_binary_s3_key" {
  type    = string
  default = "proxy/rdi-proxy"
}

variable "enable_s3_proxy_binary_access" {
  type        = bool
  description = "Enable IAM policy for EC2 to download proxy from S3"
  default     = false
}

variable "cloudwatch_log_group_name" {
  type        = string
  description = "CloudWatch log group for proxy logs (e.g. /rdi/staging/proxy)"
  default     = ""
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to resources"
  default     = {}
}
