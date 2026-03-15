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

# Proxy subnet CIDRs (use unique ranges if they conflict with existing subnets in the account)
proxy_subnet_cidr = "10.200.40.0/24"
alb_subnet_cidr   = "10.200.41.0/24"
