variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment (staging, production)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for proxy VPC"
  type        = string
  default     = "10.200.0.0/16"
}

variable "proxy_subnet_cidr" {
  description = "CIDR for proxy subnet (change if orphaned subnets exist from prior deployments)"
  type        = string
  default     = "10.200.10.0/24"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "root_volume_size" {
  description = "Root EBS volume size in GB (AL2023 AMI requires >= 30)"
  type        = number
  default     = 30
}

variable "key_name" {
  description = "Existing EC2 key pair name"
  type        = string
  default     = ""
}

variable "kms_key_arn" {
  description = "KMS key ARN for EBS encryption"
  type        = string
}

variable "proxy_websocket_port" {
  description = "Port for WebSocket (agent and frontend)"
  type        = number
  default     = 8765
}

variable "allowed_cidrs" {
  description = "CIDR blocks allowed for proxy traffic"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_ssh_cidrs" {
  description = "CIDR blocks allowed for SSH"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "user_data" {
  description = "User data script for EC2"
  type        = string
  default     = ""
}

variable "proxy_binary_s3_bucket" {
  description = "S3 bucket containing proxy binary (optional)"
  type        = string
  default     = ""
}

variable "enable_s3_proxy_binary_access" {
  description = "Enable IAM policy for EC2 to download proxy binary from S3. Set true when using proxy_binary_s3_bucket (avoids count depending on computed values)."
  type        = bool
  default     = false
}

variable "proxy_binary_s3_key" {
  description = "S3 key for proxy binary"
  type        = string
  default     = "proxy/rdi-proxy"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
