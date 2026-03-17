environment    = "staging"
regions        = ["us-east-1"]
primary_region = "us-east-1"

# Base infra state (for connection pool, Cognito)
base_state_bucket = "rdi-terraform-state-470900128247"
base_state_region = "eu-central-1"

# Wavelength Zone: Chicago (Verizon) - use Zone Name for subnet (not Zone ID)
# Zone ID use1-wl1-chi-wlz1; Zone Name us-east-1-wl1-chi-wlz-1
wavelength_zone_id = "us-east-1-wl1-chi-wlz-1"
edge_zone_ids      = ["use1-wl1-chi-wlz1"] # Zone ID for UI display

# Proxy subnet CIDRs (within 10.200.0.0/16). Bump if orphaned subnets cause InvalidSubnet.Conflict.
proxy_subnet_cidr = "10.200.60.0/24"
alb_subnet_cidr   = "10.200.61.0/24"

# Optional: fixed secret for Lambda->proxy session-status API (avoids 401 when random_password drifts)
# proxy_status_secret = "your-stable-secret-min-32-chars"

# Custom domain for WSS (trusted cert — rdistaging.com)
# After apply, set rdistaging.com NS records at your registrar to wss_custom_domain_name_servers output.
enable_custom_domain = true
domain_name          = "rdistaging.com"
subdomain            = "wss" # WebSocket host: wss.rdistaging.com (leave empty for apex)
