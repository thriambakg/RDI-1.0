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

variable "tags" {
  type        = map(string)
  description = "Tags applied to resources"
  default     = {}
}
