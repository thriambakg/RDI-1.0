environment    = "production"
regions        = ["eu-central-1", "eu-west-2"]
primary_region = "eu-central-1"

# Base infra state (for connection pool, Cognito)
# base_state_bucket = ""  # Set when base infra deployed
# base_state_region = "eu-central-1"

# Agent runs on relay hardware; ECS only runs rdi-proxy. Skip S3 agent artifact in Terraform/CI.
skip_agent_build = true

# Proxy subnet CIDR (per-region; change if conflicts)
proxy_subnet_cidr = "10.200.10.0/24"
