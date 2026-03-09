# modules/cloudfront/main.tf
# CloudFront distribution module with S3 origin

locals {
  distribution_name = "${var.project_name}-cloudfront-${var.environment}"
  oac_name          = "${var.project_name}-oac-${var.environment}"
}

# Origin Access Control for S3
resource "aws_cloudfront_origin_access_control" "s3_oac" {
  name                              = local.oac_name
  description                       = "OAC for ${var.project_name} S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# WAF WebACL for CloudFront
resource "aws_wafv2_web_acl" "cloudfront_waf" {
  count = var.create_waf ? 1 : 0

  name  = "${var.project_name}-cloudfront-waf-${var.environment}"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Rate limiting rule
  rule {
    name     = "RateLimitRule"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}RateLimitRule${var.environment}"
      sampled_requests_enabled   = true
    }
  }

  # Geographic blocking rule
  dynamic "rule" {
    for_each = length(var.waf_blocked_countries) > 0 ? [1] : []
    content {
      name     = "GeoBlockRule"
      priority = 2

      action {
        block {}
      }

      statement {
        geo_match_statement {
          country_codes = var.waf_blocked_countries
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}GeoBlockRule${var.environment}"
        sampled_requests_enabled   = true
      }
    }
  }

  # AWS Core Rule Set
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}CommonRuleSet${var.environment}"
      sampled_requests_enabled   = true
    }
  }

  # AWS Known Bad Inputs Rule Set
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}KnownBadInputs${var.environment}"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}CloudFrontWAF${var.environment}"
    sampled_requests_enabled   = true
  }

  tags = merge(var.tags, {
    Name        = "${var.project_name}-cloudfront-waf-${var.environment}"
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
  })
}

# KMS Key for CloudFront Logs Encryption
resource "aws_kms_key" "cloudfront_logs" {
  count = var.enable_logging && var.logging_bucket == null && var.kms_key_arn == null ? 1 : 0

  description             = "KMS key for ${var.project_name} CloudFront logs encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableIAMUserPermissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowCloudFrontLogsService"
        Effect = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })

  tags = merge(var.tags, {
    Name        = "${var.project_name}-cloudfront-logs-kms-${var.environment}"
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
    Purpose     = "CloudFront Logs Encryption"
  })
}

resource "aws_kms_alias" "cloudfront_logs" {
  count         = var.enable_logging && var.logging_bucket == null && var.kms_key_arn == null ? 1 : 0
  name          = "alias/${var.project_name}-cloudfront-logs-${var.environment}"
  target_key_id = aws_kms_key.cloudfront_logs[0].key_id
}

# Data source for current AWS account
data "aws_caller_identity" "current" {}

# S3 Bucket for CloudFront Access Logs
resource "aws_s3_bucket" "cloudfront_logs" {
  count  = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket = "${var.project_name}-cloudfront-logs-${var.environment}"

  tags = merge(var.tags, {
    Name        = "${var.project_name}-cloudfront-logs-${var.environment}"
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
    Purpose     = "CloudFront Access Logs"
  })
}

resource "aws_s3_bucket_versioning" "cloudfront_logs" {
  count  = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket = aws_s3_bucket.cloudfront_logs[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudfront_logs" {
  count  = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket = aws_s3_bucket.cloudfront_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn != null ? var.kms_key_arn : aws_kms_key.cloudfront_logs[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "cloudfront_logs" {
  count  = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket = aws_s3_bucket.cloudfront_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bucket ownership controls for CloudFront logging
resource "aws_s3_bucket_ownership_controls" "cloudfront_logs" {
  count  = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket = aws_s3_bucket.cloudfront_logs[0].id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }

  depends_on = [aws_s3_bucket_public_access_block.cloudfront_logs]
}

# Bucket ACL for CloudFront logging
resource "aws_s3_bucket_acl" "cloudfront_logs" {
  count      = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket     = aws_s3_bucket.cloudfront_logs[0].id
  acl        = "log-delivery-write"
  depends_on = [aws_s3_bucket_ownership_controls.cloudfront_logs]
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudfront_logs" {
  count  = var.enable_logging && var.logging_bucket == null ? 1 : 0
  bucket = aws_s3_bucket.cloudfront_logs[0].id

  rule {
    id     = "delete_old_logs"
    status = "Enabled"

    filter {
      prefix = var.logging_prefix
    }

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "distribution" {
  enabled             = true
  is_ipv6_enabled     = var.enable_ipv6
  default_root_object = var.default_root_object
  price_class         = var.price_class
  aliases             = var.aliases
  web_acl_id          = var.create_waf ? aws_wafv2_web_acl.cloudfront_waf[0].arn : var.web_acl_arn

  # S3 Origin Configuration
  origin {
    domain_name              = var.s3_bucket_domain_name
    origin_id                = var.default_cache_behavior_settings.target_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.s3_oac.id

    # Remove any existing origin_access_identity if migrating from OAI
  }

  # Default Cache Behavior
  default_cache_behavior {
    allowed_methods          = var.default_cache_behavior_settings.allowed_methods
    cached_methods           = var.default_cache_behavior_settings.cached_methods
    target_origin_id         = var.default_cache_behavior_settings.target_origin_id
    compress                 = var.default_cache_behavior_settings.compress
    viewer_protocol_policy   = var.default_cache_behavior_settings.viewer_protocol_policy
    cache_policy_id          = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.default.id

    min_ttl     = var.default_cache_behavior_settings.min_ttl
    default_ttl = var.default_cache_behavior_settings.default_ttl
    max_ttl     = var.default_cache_behavior_settings.max_ttl

    # CloudFront Function to redirect investcosine.com to fingov.ai
    dynamic "function_association" {
      for_each = length(aws_cloudfront_function.redirect_investcosine) > 0 ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.redirect_investcosine[0].arn
      }
    }
  }

  # Ordered Cache Behaviors
  dynamic "ordered_cache_behavior" {
    for_each = var.ordered_cache_behaviors
    content {
      path_pattern           = ordered_cache_behavior.value.path_pattern
      allowed_methods        = ordered_cache_behavior.value.allowed_methods
      cached_methods         = ordered_cache_behavior.value.cached_methods
      target_origin_id       = ordered_cache_behavior.value.target_origin_id
      compress               = ordered_cache_behavior.value.compress
      viewer_protocol_policy = ordered_cache_behavior.value.viewer_protocol_policy

      min_ttl     = ordered_cache_behavior.value.min_ttl
      default_ttl = ordered_cache_behavior.value.default_ttl
      max_ttl     = ordered_cache_behavior.value.max_ttl

      forwarded_values {
        query_string = ordered_cache_behavior.value.query_string
        headers      = ordered_cache_behavior.value.headers

        cookies {
          forward = ordered_cache_behavior.value.cookies_forward
        }
      }
    }
  }

  # Custom Error Responses (for SPA routing)
  dynamic "custom_error_response" {
    for_each = var.custom_error_responses
    content {
      error_code            = custom_error_response.value.error_code
      response_code         = custom_error_response.value.response_code
      response_page_path    = custom_error_response.value.response_page_path
      error_caching_min_ttl = custom_error_response.value.error_caching_min_ttl
    }
  }

  # Geographic Restrictions
  restrictions {
    geo_restriction {
      restriction_type = var.geo_restriction_type
      locations        = var.geo_restriction_locations
    }
  }

  # SSL Certificate Configuration
  viewer_certificate {
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn != null ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != null ? "TLSv1.2_2021" : null
    cloudfront_default_certificate = var.acm_certificate_arn == null ? true : null
  }

  # Logging Configuration
  dynamic "logging_config" {
    for_each = var.enable_logging ? [1] : []
    content {
      bucket          = var.logging_bucket != null ? var.logging_bucket : aws_s3_bucket.cloudfront_logs[0].bucket_domain_name
      prefix          = var.logging_prefix
      include_cookies = false
    }
  }

  tags = merge(var.tags, {
    Name        = local.distribution_name
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
  })

  # Wait for the OAC to be created
  depends_on = [
    aws_cloudfront_origin_access_control.s3_oac
  ]
}

# CloudFront Function to redirect investcosine.com to fingov.ai
# Only create if investcosine.com is in the aliases
resource "aws_cloudfront_function" "redirect_investcosine" {
  count   = length([for alias in var.aliases : alias if can(regex("investcosine\\.com", alias))]) > 0 ? 1 : 0
  name    = "${var.project_name}-redirect-investcosine-${var.environment}"
  runtime = "cloudfront-js-1.0"
  comment = "Redirect investcosine.com to fingov.ai to maintain single state"
  publish = true
  code    = <<-EOF
function handler(event) {
    var request = event.request;
    var host = request.headers.host ? request.headers.host.value : '';
    
    // Redirect investcosine.com to fingov.ai
    if (host.includes('investcosine.com')) {
        var newHost = host.replace('investcosine.com', 'fingov.ai');
        var url = 'https://' + newHost + request.uri;
        
        // Preserve query string if present
        if (request.querystring) {
            var queryString = Object.keys(request.querystring)
                .map(key => key + '=' + encodeURIComponent(request.querystring[key].value))
                .join('&');
            url += '?' + queryString;
        }
        
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': { value: url }
            }
        };
    }
    
    // Continue with normal request for other domains
    return request;
}
EOF
}

# Cache Policy for optimized caching
resource "aws_cloudfront_cache_policy" "default" {
  name        = "${var.project_name}-cache-policy-${var.environment}"
  comment     = "Cache policy for ${var.project_name}"
  default_ttl = var.default_cache_behavior_settings.default_ttl
  max_ttl     = var.default_cache_behavior_settings.max_ttl
  min_ttl     = var.default_cache_behavior_settings.min_ttl

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }

    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# Origin Request Policy
resource "aws_cloudfront_origin_request_policy" "default" {
  name    = "${var.project_name}-origin-request-policy-${var.environment}"
  comment = "Origin request policy for ${var.project_name}"

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]
    }
  }

  query_strings_config {
    query_string_behavior = "none"
  }

  cookies_config {
    cookie_behavior = "none"
  }
}



# S3 Bucket Policy for CloudFront OAC
# Note: This policy allows CloudFront to access S3 via Origin Access Control (OAC)
resource "aws_s3_bucket_policy" "cloudfront_oac_policy" {
  bucket = var.s3_bucket_id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          "${var.s3_bucket_arn}",
          "${var.s3_bucket_arn}/*"
        ]
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.distribution.arn
          }
        }
      }
    ]
  })

  # Ensure the distribution is created first, but don't block on deployment status
  depends_on = [aws_cloudfront_distribution.distribution]

  # Lifecycle to handle updates when distribution ARN changes
  lifecycle {
    create_before_destroy = false
  }
}

# DNS Records for CloudFront (if hosted zone ID is provided)
resource "aws_route53_record" "cloudfront_alias" {
  count   = var.hosted_zone_id != null && length(var.aliases) > 0 ? length(var.aliases) : 0
  zone_id = var.hosted_zone_id
  name    = var.aliases[count.index]
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.distribution.domain_name
    zone_id                = aws_cloudfront_distribution.distribution.hosted_zone_id
    evaluate_target_health = false
  }
}

# AAAA record for IPv6 support
resource "aws_route53_record" "cloudfront_alias_ipv6" {
  count   = var.hosted_zone_id != null && length(var.aliases) > 0 ? length(var.aliases) : 0
  zone_id = var.hosted_zone_id
  name    = var.aliases[count.index]
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.distribution.domain_name
    zone_id                = aws_cloudfront_distribution.distribution.hosted_zone_id
    evaluate_target_health = false
  }
}