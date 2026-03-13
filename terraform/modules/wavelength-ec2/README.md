# Wavelength EC2 Module

Deploys EC2 in an [AWS Wavelength Zone](https://docs.aws.amazon.com/wavelength/latest/developerguide/available-wavelength-zones.html) for low-latency PX4 SITL / drone control at the 5G carrier edge.

## Prerequisites

1. **Opt in to the Wavelength Zone** in AWS Console:
   - EC2 → Account Attributes → Wavelength Zones → Manage
   - Enable the target zone (e.g. Atlanta)

2. **Access**: Use SSM Session Manager (no key required) or provide `key_name` for SSH.

## Example Zone IDs (us-east-1)

| Location | Zone ID |
|----------|---------|
| Atlanta | use1-wl1-atl-wlz1 |
| Boston | use1-wl1-bos-wlz1 |
| Chicago | use1-wl1-chi-wlz1 |
| Dallas | use1-wl1-dfw-wlz1 |
| New York | use1-wl1-nyc-wlz1 |

## Connect via SSM

```bash
aws ssm start-session --target <instance-id> --region us-east-1
```
