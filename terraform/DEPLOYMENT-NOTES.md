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
- **Availability zones:** The proxy-ec2 module uses `sort(data.aws_availability_zones.available.names)` so that `names[0]` and `names[1]` are stable across runs. Without this, AWS can return AZs in a different order and Terraform would try to replace the subnets (and then the instance, ALB, etc.) and hit CIDR conflicts when creating the “new” subnets before destroying the old ones.

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

## Pipeline behavior and why “every deploy” replaced everything

### What triggers replacements (summary)
- **Subnet CIDR change** → subnets and instances that use them are replaced (one-time after fixing conflicts).
- **AMI change** → without `ignore_changes = [ami]`, instances would be replaced every time a newer AMI is returned; we use `ignore_changes = [ami]` to avoid that.
- **`null_resource.proxy_build` / `agent_build`** → triggers are `filemd5(Cargo.toml)`, `filemd5(main.rs)`, `filemd5(build script)`. If proxy/agent **code** or build scripts change, these resources are replaced, which can force S3 object and downstream updates. If only **infra** (e.g. Terraform, Lambda, frontend) changes, those hashes are unchanged so these null_resources are **not** replaced.
- **Lambda layer** → new layer zip or hash → new layer version, Lambda config update.
- **API Gateway** → redeployment triggers (e.g. integration changes) can force a new deployment.
- **rdi_edge** → `null_resource.proxy_ready` trigger is `proxy_instance_id`; if the proxy instance is replaced (e.g. subnet change), this and ALB/target attachments change.

So after a one-time subnet (or similar) fix, **infra-only** pushes should not replace EC2s if AMI is ignored and proxy/agent source files are unchanged.

### Two workflows (recommended)
- **Deploy Application Infrastructure** (main workflow) runs on **infra paths only**: `terraform/**`, `backend_app/**`, `.github/workflows/**`, `frontend/**`, `src/session-api/**`, `src/wavelength/**`, `scripts/**`. Changes under `src/proxy` or `src/agent` (proxy/agent **code** only) do **not** trigger this workflow, so no Terraform apply and no EC2 replacement from those commits.
- **Deploy EC2 code** (separate workflow) runs only when **proxy/agent code** changes: `src/proxy/**`, `src/agent/**`. It builds binaries, uploads to S3, and uses **SSM Run Command** to run `update-from-s3.sh` on proxy and Wavelength instances so they pull the new binary and restart. No Terraform, no instance replacement.

Result: infra changes → main pipeline (Terraform, Lambda, etc.); proxy/agent code changes → code-only pipeline (S3 + SSM in-place update). Target group stays healthy when only proxy/agent code is updated.
