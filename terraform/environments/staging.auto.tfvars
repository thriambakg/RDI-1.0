environment    = "staging"
regions        = ["us-east-1"]
primary_region = "us-east-1"

# Base infra state (for connection pool, Cognito)
base_state_bucket = "rdi-terraform-state-470900128247"
base_state_region = "eu-central-1"

# Agent binary: not uploaded to S3 — agent runs on relays (build from src/agent locally or separate release).
# ECS proxy image only contains rdi-proxy (WebSocket hub), not the MAVLink UDP agent.
skip_agent_build = true

# Proxy: DEPRECATED — WebRTC/KVS data plane (use_proxy_ecs=false)
use_proxy_ecs = false
data_plane    = "webrtc"

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
