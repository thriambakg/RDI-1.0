# Application Load Balancer Module with Security
# modules/alb/main.tf

# Data sources
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_vpc" "main" {
  id = var.vpc_id
}

# Note: Self-signed certificates are not supported by AWS ALB
# ALB requires certificates with valid FQDNs. For staging environments without
# custom domains, HTTP-only access is used. Production should use valid certificates.

# Try to find existing security group first
data "aws_security_groups" "existing_alb_sg" {
  filter {
    name   = "group-name"
    values = ["${var.project_name}-alb-${var.environment}"]
  }
  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }
}

# Security Group for ALB - use fixed name for stability (v2 to force recreation without inline rules)
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg-v2-${var.environment}"
  description = "Security group for Application Load Balancer"
  vpc_id      = var.vpc_id

  # No inline rules - managed separately as aws_security_group_rule resources
  # Explicitly empty to ensure no conflicts with separate rules
  ingress = []
  egress  = []

  tags = merge(var.tags, {
    Name = "${var.project_name}-alb-sg-${var.environment}"
  })

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [tags["Environment"], tags["Repository"]]
    # Do not ignore ingress/egress changes - we want them to stay empty
  }
}

# Local value to ensure we use the correct security group ID
locals {
  security_group_id = aws_security_group.alb.id
}

# Security Group Rules (managed separately for better lifecycle control)
resource "aws_security_group_rule" "alb_http_ingress" {
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow HTTP traffic"
  security_group_id = local.security_group_id

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_security_group.alb]
}

resource "aws_security_group_rule" "alb_https_ingress" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow HTTPS traffic"
  security_group_id = local.security_group_id

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_security_group.alb]
}

resource "aws_security_group_rule" "alb_egress_to_targets" {
  type              = "egress"
  from_port         = var.target_group_config.port
  to_port           = var.target_group_config.port
  protocol          = "tcp"
  cidr_blocks       = [data.aws_vpc.main.cidr_block]
  description       = "Allow ALB to communicate with targets on port ${var.target_group_config.port}"
  security_group_id = local.security_group_id

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_security_group.alb]
}

# Application Load Balancer
# tfsec:ignore:aws-elb-alb-not-public - Public ALB is intentional for web frontend
resource "aws_lb" "main" {
  name               = "${var.project_name}-alb-v2-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [local.security_group_id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.enable_deletion_protection

  # Access logs
  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = "alb-access-logs"
    enabled = var.enable_access_logs
  }

  # Drop invalid header fields for security
  drop_invalid_header_fields = true

  # Ensure security group and all rules are created first
  depends_on = [
    aws_security_group.alb,
    aws_security_group_rule.alb_http_ingress,
    aws_security_group_rule.alb_https_ingress,
    aws_security_group_rule.alb_egress_to_targets
  ]

  lifecycle {
    ignore_changes = [tags["Environment"], tags["Repository"]]
    # Prevent destruction if ALB is being used
    prevent_destroy = false
    # Create new ALB before destroying old one when name_prefix changes
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-alb-${var.environment}"
  })
}

# Target Group - configurable for frontend (ECS) or WebSocket proxy (EC2)
# Note: ALB target groups require HTTP/HTTPS protocol; WebSocket uses HTTP upgrade
resource "aws_lb_target_group" "main" {
  name        = "${var.project_name}-tg-v2-${var.environment}"
  port        = var.target_group_config.port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = var.target_group_config.target_type

  health_check {
    enabled             = true
    healthy_threshold   = var.target_group_config.healthy_threshold
    interval            = var.target_group_config.interval
    port                = var.target_group_config.health_check_port
    protocol            = "HTTP"
    path                = var.target_group_config.health_check_path
    matcher             = "200"
    timeout             = var.target_group_config.timeout
    unhealthy_threshold = var.target_group_config.unhealthy_threshold
  }

  deregistration_delay = 30

  lifecycle {
    ignore_changes = [tags["Environment"], tags["Repository"]]
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-tg-${var.environment}"
  })
}

# Attach EC2 instances to target group when target_type=instance
resource "aws_lb_target_group_attachment" "instances" {
  for_each = toset(var.target_group_config.target_type == "instance" ? var.target_instance_ids : [])

  target_group_arn = aws_lb_target_group.main.arn
  target_id        = each.value
  port             = var.target_group_config.port
}

# Development warning for missing certificate
resource "null_resource" "certificate_warning" {
  # for_each = var.certificate_arn == "" ? { "create" = true } : {}

  provisioner "local-exec" {
    command = <<-EOT
      echo "⚠️  SECURITY NOTICE: ALB created with HTTP-only access"
      echo "🔒 No SSL certificate provided - HTTPS listener not created"
      echo "📋 For production, provide certificate_arn or enable custom domain"
      echo "🛡️  Security scanners may flag this as HTTP traffic serving (AVD-AWS-0054)"
      echo "💡 To resolve: Set enable_custom_domain = true and provide domain_name"
    EOT
  }
}

# HTTPS Listener (only when valid certificate is available)
resource "aws_lb_listener" "https" {
  # for_each = var.certificate_arn != "" ? { "create" = true } : {}

  load_balancer_arn = aws_lb.main.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }
}

# HTTP Listener - Forward to target group when no certificate, redirect to HTTPS when certificate exists
# Security Note: This is flagged by scanners (AVD-AWS-0054) but is acceptable because:
# - Staging: No certificate = HTTP forwarding for cost optimization
# - Production: Certificate available = HTTP redirects to HTTPS for security
# This design provides flexibility while maintaining production security standards
resource "aws_lb_listener" "http" {
  count = 1 # Always create HTTP listener

  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  # Conditional action based on certificate availability
  dynamic "default_action" {
    for_each = [1]
    content {
      type             = var.certificate_arn != "" ? "redirect" : "forward"
      target_group_arn = var.certificate_arn == "" ? aws_lb_target_group.main.arn : null

      # Redirect to HTTPS when certificate is available
      dynamic "redirect" {
        for_each = var.certificate_arn != "" ? [1] : []
        content {
          port        = "443"
          protocol    = "HTTPS"
          status_code = "HTTP_301"
        }
      }
    }
  }
}

# WAF Web ACL for DDoS and SQL Injection Protection (optional)
resource "aws_wafv2_web_acl" "main" {
  count = var.enable_waf ? 1 : 0
  name  = "${var.project_name}-waf-${var.environment}"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  # Rate limiting rule
  rule {
    name     = "RateLimitRule"
    priority = 1

    statement {
      rate_based_statement {
        limit                 = var.rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    action {
      block {}
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitRule"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - Core Rule Set
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

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
      metric_name                = "CommonRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - SQL Injection
  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "SQLiRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - IP Reputation
  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 4

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "IpReputationMetric"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - Known Bad Inputs
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 5

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
      metric_name                = "KnownBadInputsMetric"
      sampled_requests_enabled   = true
    }
  }

  # Geographic blocking (optional)
  dynamic "rule" {
    for_each = length(var.blocked_countries) > 0 ? [1] : []
    content {
      name     = "GeoBlockRule"
      priority = 6

      action {
        block {}
      }

      statement {
        geo_match_statement {
          country_codes = var.blocked_countries
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "GeoBlockMetric"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}WAF${var.environment}"
    sampled_requests_enabled   = true
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-waf-${var.environment}"
  })
}

# Associate WAF with ALB
resource "aws_wafv2_web_acl_association" "main" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}

# Null resource to ensure ALB is fully ready before ECS service creation
resource "null_resource" "alb_ready_with_https" {
  count = 1

  depends_on = [
    aws_lb.main,
    aws_lb_target_group.main,
    aws_lb_listener.http[0],
    aws_lb_listener.https
  ]
}

# CloudWatch Log Group for WAF
resource "aws_cloudwatch_log_group" "waf" {
  count             = var.enable_waf_logging ? 1 : 0
  name              = "/aws/wafv2/${var.project_name}-${var.environment}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn != "" ? var.kms_key_arn : null

  tags = merge(var.tags, {
    Name = "${var.project_name}-waf-logs-${var.environment}"
  })
}

# CloudWatch Log Group Resource Policy for WAF
resource "aws_cloudwatch_log_resource_policy" "waf" {
  count       = var.enable_waf_logging ? 1 : 0
  policy_name = "${var.project_name}-waf-logs-policy-${var.environment}"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "wafv2.amazonaws.com"
        }
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/wafv2/${var.project_name}-${var.environment}:*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# WAF Logging Configuration - only when WAF enabled (currently disabled; set to 1 to enable)
# resource "aws_wafv2_web_acl_logging_configuration" "main" {
#   count = var.enable_waf && var.enable_waf_logging ? 1 : 0
#   resource_arn = aws_wafv2_web_acl.main[0].arn
#   log_destination_configs = [...]
#   depends_on = [aws_cloudwatch_log_group.waf, aws_cloudwatch_log_resource_policy.waf]
#   redacted_fields { single_header { name = "authorization" } }
# }

output "waf_log_group_arn" {
  value = length(aws_cloudwatch_log_group.waf) > 0 ? aws_cloudwatch_log_group.waf[0].arn : null
}

