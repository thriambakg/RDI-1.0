# RDI Edge bundle: Proxy EC2 + ALB (WebSocket) + Wavelength EC2.
# Wraps the existing proxy-ec2, alb, and wavelength-ec2 modules so root calls one module.
# Individual module definitions remain in ./proxy-ec2, ./alb, ./wavelength-ec2 for standalone use.

locals {
  create_proxy = var.infra_version > 0
  create_alb   = var.enable_alb_wss && var.alb_subnet_cidr != "" && var.infra_version > 0
  create_wl    = var.wavelength_zone_id != "" && var.infra_version > 0
  # Path to repo src from this module (modules/rdi-edge -> ../../../src)
  src_root = "${path.module}/../../../src"
}

# --- Proxy EC2 ---
module "proxy_ec2" {
  count  = local.create_proxy ? 1 : 0
  source = "../proxy-ec2"

  project_name                  = var.project_name
  environment                   = var.environment
  kms_key_arn                   = var.kms_key_arn
  proxy_websocket_port          = 8765
  proxy_health_port             = 8766
  proxy_status_port             = 8767
  proxy_binary_s3_bucket        = var.proxy_artifacts_bucket_id
  proxy_binary_s3_key           = var.proxy_binary_s3_key
  enable_s3_proxy_binary_access = true
  proxy_subnet_cidr             = var.proxy_subnet_cidr
  alb_subnet_cidr               = local.create_alb ? var.alb_subnet_cidr : ""
  cloudwatch_log_group_name     = var.cloudwatch_log_group_proxy

  user_data = base64encode(templatefile("${local.src_root}/proxy/user_data.sh", {
    s3_bucket            = var.proxy_artifacts_bucket_id
    s3_key               = var.proxy_binary_s3_key
    ws_port              = 8765
    health_port          = 8766
    status_port          = 8767
    status_secret        = var.proxy_status_secret
    cloudwatch_log_group = var.cloudwatch_log_group_proxy
    infra_version        = var.infra_version
  }))

  tags = var.tags
}

# --- Wavelength EC2 ---
module "wavelength_ec2" {
  count  = local.create_wl ? 1 : 0
  source = "../wavelength-ec2"

  project_name                  = var.project_name
  environment                   = var.environment
  wavelength_zone_id            = var.wavelength_zone_id
  kms_key_arn                   = var.kms_key_arn
  key_name                      = ""
  allowed_ssh_cidrs             = ["0.0.0.0/0"]
  allowed_mavlink_cidrs         = ["0.0.0.0/0"]
  allowed_api_cidrs             = ["0.0.0.0/0"]
  mavlink_port                  = var.mavlink_port
  agent_binary_s3_bucket        = var.agent_binary_s3_bucket
  agent_binary_s3_key           = var.agent_binary_s3_key
  enable_agent_binary_s3_access = var.enable_agent_binary_s3_access
  cloudwatch_log_group_name     = var.cloudwatch_log_group_agent

  user_data = base64encode(templatefile("${local.src_root}/wavelength/user_data.sh", {
    s3_bucket            = var.agent_binary_s3_bucket
    s3_key               = var.agent_binary_s3_key
    aws_region           = var.region
    cloudwatch_log_group = var.cloudwatch_log_group_agent
    infra_version        = var.infra_version
  }))

  tags = var.tags
}

# Wait for proxy to finish user_data and serve health checks before creating ALB/target group.
# Otherwise the target group is attached immediately and health checks fail until the proxy is ready.
resource "null_resource" "proxy_ready" {
  count = local.create_alb && var.proxy_ready_delay_seconds > 0 ? 1 : 0

  triggers = {
    proxy_instance_id = module.proxy_ec2[0].instance_id
  }

  provisioner "local-exec" {
    command = var.proxy_ready_delay_seconds > 0 ? "sleep ${var.proxy_ready_delay_seconds}" : "true"
  }

  depends_on = [module.proxy_ec2]
}

# --- ALB for WebSocket (TLS) ---
# Created after proxy_ready so the target group sees a healthy proxy (avoids initial unhealthy state).
module "alb_websocket" {
  count  = local.create_alb ? 1 : 0
  source = "../alb"

  project_name       = var.project_name
  environment        = var.environment
  name_suffix        = "-v${var.infra_version}"
  vpc_id             = module.proxy_ec2[0].vpc_id
  public_subnet_ids  = module.proxy_ec2[0].alb_subnet_ids
  certificate_arn    = var.certificate_arn
  kms_key_arn        = var.kms_key_arn
  enable_waf         = false
  enable_waf_logging = false
  access_logs_bucket = ""
  enable_access_logs = false
  # WebSocket: keep connections up while session is active; TTL/idle is handled by Lambda (idle_after), not by ALB
  idle_timeout_seconds = 3600

  target_group_config = {
    port                = 8765
    target_type         = "instance"
    health_check_path   = "/"
    health_check_port   = "8766"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 10
  }
  target_instance_ids = [module.proxy_ec2[0].instance_id]

  tags = var.tags

  depends_on = [module.proxy_ec2, null_resource.proxy_ready]
}

