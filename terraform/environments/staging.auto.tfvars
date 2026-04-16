environment    = "staging"
regions        = ["us-east-1"]
primary_region = "us-east-1"

# Base infra state (for connection pool, Cognito)
base_state_bucket = "rdi-terraform-state-470900128247"
base_state_region = "eu-central-1"

# Wavelength edge EC2 disabled — relays use internet (e.g. Starlink) to reach regional API/proxy.
wavelength_zone_id = ""
edge_zone_ids      = ["us-east-1"] # AWS regions (docs / outputs; UI uses frontend config)

# Proxy: ECS Fargate (true) or EC2 rdi_edge (false)
use_proxy_ecs = true

# Proxy subnet CIDRs (within 10.200.0.0/16). Used when use_proxy_ecs=false.
proxy_subnet_cidr = "10.200.82.0/24"
alb_subnet_cidr   = "10.200.83.0/24"

# Optional: fixed secret for Lambda->proxy session-status API (avoids 401 when random_password drifts)
# proxy_status_secret = "your-stable-secret-min-32-chars"

# Custom domain for WSS (trusted cert — rdistaging.com)
# After apply, set rdistaging.com NS records at your registrar to wss_custom_domain_name_servers output.
enable_custom_domain = true
domain_name          = "rdistaging.com"
subdomain            = "wss" # WebSocket host: wss.rdistaging.com (leave empty for apex)
