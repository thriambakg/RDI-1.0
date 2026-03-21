# Import existing ALB and Target Group into rdi_edge state (run from terraform dir).
# Use when you moved from root-level module.alb_websocket to module.rdi_edge and resources already exist in AWS.
# Requires: AWS CLI configured, Terraform initialized.
#
# Usage: .\import-rdi-edge-alb.ps1 [infra_version]
#   infra_version defaults to 4 (e.g. ALB name rdi-alb-v2-staging-v4).

param([int]$InfraVersion = 4)

$ErrorActionPreference = "Stop"
$Region = "us-east-1"
$TfDir = if (Test-Path "main.tf") { "." } else { ".." }
Push-Location $TfDir

try {
  $Project = "rdi"
  $EnvName = "staging"
  $v = $InfraVersion
  $AlbName = "${Project}-alb-v2-${EnvName}-v${v}"
  $TgName  = "${Project}-tg-v2-${EnvName}-v${v}"

  $AlbArn = (aws elbv2 describe-load-balancers --region $Region --names $AlbName --query "LoadBalancers[0].LoadBalancerArn" --output text 2>$null)
  if (-not $AlbArn -or $AlbArn -eq "None") { throw "ALB not found: $AlbName" }

  $TgArn = (aws elbv2 describe-target-groups --region $Region --names $TgName --query "TargetGroups[0].TargetGroupArn" --output text 2>$null)
  if (-not $TgArn -or $TgArn -eq "None") { throw "Target group not found: $TgName" }

  Write-Host "Importing ALB: $AlbArn"
  terraform import -var-file=environments/staging.auto.tfvars "module.rdi_edge[0].module.alb_websocket[0].aws_lb.main" $AlbArn

  Write-Host "Importing Target Group: $TgArn"
  terraform import -var-file=environments/staging.auto.tfvars "module.rdi_edge[0].module.alb_websocket[0].aws_lb_target_group.main" $TgArn

  Write-Host "Done. Run terraform plan to confirm no more creates for these resources."
} finally {
  Pop-Location
}
