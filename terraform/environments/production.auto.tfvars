environment    = "production"
regions        = ["eu-central-1", "eu-west-2"]
primary_region = "eu-central-1"

# wavelength_zone_id is set per-region in production/eu-central-1.tfvars and production/eu-west-2.tfvars.
# Pass the region var file when applying (e.g. -var-file=environments/production/eu-central-1.tfvars).
# Without it, wavelength_zone_id defaults to "" and no Wavelength EC2 is created.

# Base infra state (for connection pool, Cognito)
# base_state_bucket = ""  # Set when base infra deployed
# base_state_region = "eu-central-1"

# Edge zones available in production (Europe — Frankfurt & London)
# Berlin, Dortmund, Munich (Vodafone); London, Manchester (Vodafone), Manchester (BT)
edge_zone_ids = [
  "euc1-wl1-ber-wlz1",
  "euc1-wl1-dtm-wlz1",
  "euc1-wl1-muc-wlz1",
  "euw2-wl1-lon-wlz1",
  "euw2-wl1-man-wlz1",
  "euw2-wl2-man-wlz1",
]

# Proxy subnet CIDR (per-region; change if conflicts)
proxy_subnet_cidr = "10.200.10.0/24"
