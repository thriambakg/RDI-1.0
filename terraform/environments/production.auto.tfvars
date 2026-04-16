environment    = "production"
regions        = ["eu-central-1", "eu-west-2"]
primary_region = "eu-central-1"

# Wavelength edge EC2: leave wavelength_zone_id empty in per-region tfvars unless re-enabling the module.

# Base infra state (for connection pool, Cognito)
# base_state_bucket = ""  # Set when base infra deployed
# base_state_region = "eu-central-1"

# AWS regions for docs/outputs (align with frontend Region selector)
edge_zone_ids = [
  "eu-central-1",
  "us-east-1",
  "us-east-2",
]

# Proxy subnet CIDR (per-region; change if conflicts)
proxy_subnet_cidr = "10.200.10.0/24"
