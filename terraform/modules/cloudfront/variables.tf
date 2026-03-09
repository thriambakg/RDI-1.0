# modules/cloudfront/variables.tf
# Input variables for the CloudFront module

variable "project_name" {
  description = "Name of the project for naming resources"
  type        = string
}

variable "environment" {
  description = "Environment (staging, production, etc.)"
  type        = string
}

variable "s3_bucket_domain_name" {
  description = "Domain name of the S3 bucket origin"
  type        = string
}

variable "s3_bucket_id" {
  description = "ID of the S3 bucket for OAC"
  type        = string
}

variable "s3_bucket_arn" {
  description = "ARN of the S3 bucket for OAC policy"
  type        = string
}

variable "aliases" {
  description = "Custom domain aliases for the CloudFront distribution"
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for HTTPS"
  type        = string
  default     = null
}

variable "default_root_object" {
  description = "Default root object for the distribution"
  type        = string
  default     = "index.html"
}

variable "price_class" {
  description = "Price class for the CloudFront distribution"
  type        = string
  default     = "PriceClass_100"
  validation {
    condition = contains([
      "PriceClass_All",
      "PriceClass_200",
      "PriceClass_100"
    ], var.price_class)
    error_message = "Price class must be PriceClass_All, PriceClass_200, or PriceClass_100."
  }
}

variable "custom_error_responses" {
  description = "Custom error responses for SPA routing"
  type = list(object({
    error_code            = number
    response_code         = number
    response_page_path    = string
    error_caching_min_ttl = number
  }))
  default = [
    {
      error_code            = 403
      response_code         = 200
      response_page_path    = "/index.html"
      error_caching_min_ttl = 0
    },
    {
      error_code            = 404
      response_code         = 200
      response_page_path    = "/index.html"
      error_caching_min_ttl = 0
    }
  ]
}

variable "default_cache_behavior_settings" {
  description = "Settings for the default cache behavior"
  type = object({
    allowed_methods        = list(string)
    cached_methods         = list(string)
    target_origin_id       = string
    compress               = bool
    viewer_protocol_policy = string
    min_ttl                = number
    default_ttl            = number
    max_ttl                = number
  })
  default = {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3Origin"
    compress               = true
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }
}

variable "ordered_cache_behaviors" {
  description = "Ordered cache behaviors for the distribution"
  type = list(object({
    path_pattern           = string
    allowed_methods        = list(string)
    cached_methods         = list(string)
    target_origin_id       = string
    compress               = bool
    viewer_protocol_policy = string
    min_ttl                = number
    default_ttl            = number
    max_ttl                = number
    headers                = list(string)
    query_string           = bool
    cookies_forward        = string
  }))
  default = []
}

variable "geo_restriction_type" {
  description = "Type of geo restriction (none, whitelist, blacklist)"
  type        = string
  default     = "none"
}

variable "geo_restriction_locations" {
  description = "List of country codes for geo restriction"
  type        = list(string)
  default     = []
}

variable "enable_logging" {
  description = "Whether to enable CloudFront logging"
  type        = bool
  default     = true
}

variable "logging_bucket" {
  description = "S3 bucket for CloudFront logs"
  type        = string
  default     = null
}

variable "logging_prefix" {
  description = "Prefix for CloudFront log files"
  type        = string
  default     = "cloudfront-logs/"
}

variable "enable_ipv6" {
  description = "Whether to enable IPv6 for the distribution"
  type        = bool
  default     = true
}

variable "web_acl_arn" {
  description = "ARN of the WAF WebACL to associate with CloudFront distribution"
  type        = string
  default     = null
}

variable "create_waf" {
  description = "Whether to create a WAF WebACL for the CloudFront distribution"
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "Rate limit for WAF rule (requests per 5-minute period)"
  type        = number
  default     = 10000
}

variable "waf_blocked_countries" {
  description = "List of country codes to block in WAF"
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "ARN of the KMS key for encrypting CloudFront logs S3 bucket"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags to apply to the CloudFront distribution"
  type        = map(string)
  default     = {}
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID for creating DNS records (optional)"
  type        = string
  default     = null
}