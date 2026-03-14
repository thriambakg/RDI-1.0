environment    = "staging"
regions        = ["us-east-1"]
primary_region = "us-east-1"

# Base infra state (for connection pool, Cognito)
base_state_bucket = "rdi-terraform-state-470900128247"
base_state_region = "eu-central-1"

# Wavelength Zone: Chicago - single zone for MVP
wavelength_zone_id = "us-east-1-wl1-chi-wlz-1"

# Proxy subnet CIDR (change if conflicts with orphaned subnets)
proxy_subnet_cidr = "10.200.10.0/24"
