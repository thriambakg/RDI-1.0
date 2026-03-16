# Wavelength EC2 Module Variables

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment (staging, production)"
  type        = string
}

variable "wavelength_zone_id" {
  description = "Wavelength Zone ID (e.g. use1-wl1-atl-wlz1 for Atlanta)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for Wavelength VPC"
  type        = string
  default     = "10.100.0.0/16"
}

variable "wavelength_subnet_cidr" {
  description = "CIDR for subnet in Wavelength Zone"
  type        = string
  default     = "10.100.1.0/24"
}

variable "instance_type" {
  description = "EC2 instance type (t3.medium recommended for PX4 SITL)"
  type        = string
  default     = "t3.medium"
}

variable "root_volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 30
}

variable "key_name" {
  description = "Existing EC2 key pair name. If empty, creates one (stored in state - use for dev only)"
  type        = string
  default     = ""
}

variable "kms_key_arn" {
  description = "KMS key ARN for EBS encryption"
  type        = string
}

variable "allowed_ssh_cidrs" {
  description = "CIDR blocks allowed for SSH"
  type        = list(string)
  default     = ["0.0.0.0/0"] # Restrict in production
}

variable "allowed_mavlink_cidrs" {
  description = "CIDR blocks allowed for MAVLink (14540-14550)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "mavlink_port" {
  description = "MAVLink UDP port for PX4 (14540 legacy, 18570 v1.13+). Used in user_data / agent env."
  type        = number
  default     = 18570
}

variable "allowed_api_cidrs" {
  description = "CIDR blocks allowed for HTTP API (8080)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "user_data" {
  description = "User data script for EC2 (install PX4, MAVSDK, etc.)"
  type        = string
  default     = ""
}

variable "agent_binary_s3_bucket" {
  description = "S3 bucket containing RDI agent binary (optional)"
  type        = string
  default     = ""
}

variable "agent_binary_s3_key" {
  description = "S3 key for agent binary"
  type        = string
  default     = "agent/rdi-agent"
}

variable "enable_agent_binary_s3_access" {
  description = "Enable IAM policy for EC2 to download agent binary from S3"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

variable "cloudwatch_log_group_name" {
  description = "CloudWatch Log group name for agent logs (e.g. /rdi/staging/agent). When set, instance role gets write access and user_data ships /var/log/rdi-agent.log."
  type        = string
  default     = ""
}
