# Terraform deployment notes

## Why does the plan show so many replacements?

### One-time: subnet CIDR change
If you changed `proxy_subnet_cidr` or `alb_subnet_cidr` in `environments/staging.auto.tfvars` (e.g. from `10.200.62.0/24` to `10.200.72.0/24` to fix `InvalidSubnet.Conflict`), Terraform **must replace**:

- `aws_subnet.proxy` and `aws_subnet.alb` (CIDR is immutable)
- `aws_instance.proxy` (depends on proxy subnet)
- `aws_instance.wavelength` (no direct subnet change, but can be re-evaluated)
- `aws_route_table_association.proxy` and `.alb`
- ALB subnets, target group attachments, and related resources

That produces a large “Plan: X to add, Y to change, Z to destroy.” After you apply **once**, the new subnets and instances are in place; the next plan (without further CIDR or structural changes) should show few or no changes.

### “Will be read during apply”
Data sources like `data.aws_caller_identity.current`, `data.aws_region.current`, `data.aws_ami.amazon_linux` often show “will be read during apply” when they are used by a resource that is being **replaced**. Terraform defers reading them until apply. This does **not** mean every future run will replace things; it’s just how this run’s plan is displayed.

### Reducing churn on future runs
- **AMI:** The proxy and wavelength EC2 modules use `lifecycle { ignore_changes = [ami] }` on the instance so that when `data.aws_ami.amazon_linux` (e.g. `most_recent = true`) returns a newer AMI, Terraform will **not** replace the instance. You can still roll out a new AMI by temporarily removing that `ignore_changes` or by tainting the instance.
- **Subnet CIDRs:** Leave `proxy_subnet_cidr` and `alb_subnet_cidr` unchanged after the conflict is resolved so subnets (and everything that depends on them) are not replaced again.

## Getting the full plan list

From the repo root, with the same vars you use for apply (e.g. staging):

```bash
cd terraform
terraform plan -var-file=environments/staging.auto.tfvars -out=tfplan -no-color 2>&1 | tee plan.txt
```

Or with environment variables instead of `-var-file`:

```bash
terraform plan -no-color 2>&1 | tee plan.txt
```

Then open `plan.txt` for the full list of resources to add, change, or destroy. Summary line at the end: `Plan: X to add, Y to change, Z to destroy.`
