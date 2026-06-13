variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "region" {
  description = "AWS region for this deployment (each region gets its own state and resources)"
  type        = string
  default     = "us-east-1"
}

variable "regions" {
  description = "List of all regions to deploy to (for resources that need cross-region awareness)"
  type        = list(string)
  default     = []
}

variable "primary_region" {
  description = "Primary region for replication sources (S3, DynamoDB global tables, etc.)"
  type        = string
  default     = ""
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "rdi"
}

variable "mavlink_port" {
  description = "MAVLink UDP port for PX4 (14540 legacy, 18570 v1.13+). Session API default for session metadata."
  type        = number
  default     = 18570
}

variable "base_state_bucket" {
  description = "S3 bucket for base infra state (for reading connection pool, Cognito)"
  type        = string
  default     = ""
}

variable "base_state_key" {
  description = "S3 key for base infra state"
  type        = string
  default     = ""
}

variable "base_state_region" {
  description = "Region where base state bucket lives"
  type        = string
  default     = "eu-central-1"
}

variable "skip_proxy_build" {
  description = "Skip building and uploading the proxy binary (EC2 will use Python fallback). Set true when Rust is not available (e.g. terraform plan only)."
  type        = bool
  default     = false
}

variable "skip_agent_build" {
  description = "Skip Terraform local-exec build and S3 upload of rdi-agent. Use true when agent runs only on relays (Starlink/laptop); ECS image is proxy-only."
  type        = bool
  default     = false
}

variable "proxy_subnet_cidr" {
  description = "CIDR for proxy EC2 subnet (within 10.200.0.0/16). Change if orphaned subnets conflict."
  type        = string
  default     = "10.200.40.0/24"
}

variable "alb_subnet_cidr" {
  description = "CIDR for second proxy subnet (for ALB multi-AZ). Empty = no ALB, use direct proxy IP."
  type        = string
  default     = "10.200.41.0/24"
}

variable "enable_alb_wss" {
  description = "Enable ALB for WSS (TLS). Requires alb_subnet_cidr and certificate."
  type        = bool
  default     = true
}

variable "certificate_arn" {
  description = "ACM certificate ARN for ALB HTTPS/WSS. Empty = use ssl-certificate module (self-signed for staging). Ignored when enable_custom_domain is true."
  type        = string
  default     = ""
}

# Custom domain for WSS (trusted cert, works in all browsers and on phones)
variable "enable_custom_domain" {
  description = "Use custom domain + ACM DNS-validated cert for WSS so connections are trusted in all browsers and on phones. Requires domain_name; optionally set subdomain (e.g. wss.staging for wss.staging.rdi.example.com)."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Root domain you control for custom domain (e.g. rdi.example.com). Required when enable_custom_domain is true; delegate this domain to the created Route53 hosted zone."
  type        = string
  default     = ""
}

variable "subdomain" {
  description = "Subdomain for the WebSocket host (e.g. wss.staging for wss.staging.rdi.example.com). Leave empty to use domain_name as the host."
  type        = string
  default     = ""
}

variable "proxy_status_secret" {
  description = "Fixed secret for Lambda->proxy session-status API. When set, stored in Secrets Manager and used by Lambda and proxy (avoids drift from random_password). Leave empty to use auto-generated value."
  type        = string
  default     = ""
  sensitive   = true
}

variable "use_proxy_ecs" {
  description = "DEPRECATED: ECS Fargate rdi-proxy (WebSocket). Set false — data plane is WebRTC/KVS."
  type        = bool
  default     = false
}

variable "data_plane" {
  description = "Session data plane: webrtc (KVS signaling) or websocket (legacy proxy)."
  type        = string
  default     = "webrtc"
}
