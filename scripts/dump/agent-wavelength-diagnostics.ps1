# "No agent connected" diagnostics: EC2 instances, Session API Lambda env, SSM.
# Run from RDI-1.0 with AWS CLI configured. Staging uses us-east-1.

param(
    [string]$Region = $env:AWS_REGION
)
if (-not $Region) { $Region = "us-east-1" }
$env:AWS_DEFAULT_REGION = $Region

Write-Host "=== Agent / Wavelength diagnostics (region: $Region) ===" -ForegroundColor Cyan
Write-Host "Use when ping shows 'Proxy reached; no agent on Wavelength instance'." -ForegroundColor Gray
Write-Host ""

# 1) EC2 instances (RDI-related: proxy, Wavelength)
Write-Host "1. EC2 instances (rdi in name or tag)" -ForegroundColor Yellow
$instances = aws ec2 describe-instances --region $Region `
    --filters "Name=instance-state-name,Values=running" `
    --query "Reservations[*].Instances[*].{Id:InstanceId,Name:Tags[?Key=='Name']|[0].Value,State:State.Name,PrivateIp:PrivateIpAddress}" `
    --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Error: $instances"
} else {
    $list = $instances | ConvertFrom-Json
    $flat = @()
    foreach ($r in $list) { foreach ($i in $r) { $flat += $i } }
    $rdi = $flat | Where-Object { $_.Name -match "rdi" -or $_.Id -match "i-" }
    foreach ($i in $rdi) {
        $name = if ($i.Name) { $i.Name } else { "(no name)" }
        Write-Host "   $($i.Id)  $name  $($i.PrivateIp)"
    }
    if ($rdi.Count -eq 0) {
        Write-Host "   (No running instances; list all below)"
        foreach ($i in $flat) {
            $name = if ($i.Name) { $i.Name } else { "(no name)" }
            Write-Host "   $($i.Id)  $name  $($i.PrivateIp)"
        }
    }
}
Write-Host ""

# 2) Session API Lambda env (WAVELENGTH_INSTANCE_ID, PROXY_ENDPOINT)
Write-Host "2. Session API Lambda env (WAVELENGTH_INSTANCE_ID, PROXY_ENDPOINT, WAVELENGTH_ZONE_ID)" -ForegroundColor Yellow
$script:WavelengthInstanceId = $null
$fn = "rdi-session-api-staging-$Region"
$cfg = aws lambda get-function-configuration --region $Region --function-name $fn --query "Environment.Variables" --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Function $fn not found or error: $cfg"
} else {
    $vars = $cfg | ConvertFrom-Json
    $script:WavelengthInstanceId = $vars.WAVELENGTH_INSTANCE_ID
    $pe  = $vars.PROXY_ENDPOINT
    $wz  = $vars.WAVELENGTH_ZONE_ID
    Write-Host "   WAVELENGTH_INSTANCE_ID = $script:WavelengthInstanceId"
    Write-Host "   PROXY_ENDPOINT         = $pe"
    Write-Host "   WAVELENGTH_ZONE_ID     = $wz"
    if (-not $script:WavelengthInstanceId) {
        Write-Host "   WARNING: WAVELENGTH_INSTANCE_ID is empty — Lambda will never start the agent." -ForegroundColor Red
    }
    if (-not $pe) {
        Write-Host "   WARNING: PROXY_ENDPOINT is empty — agent would not know where to connect." -ForegroundColor Red
    }
}
Write-Host ""

# 3) SSM managed instances (instance must be registered for SendCommand to work)
Write-Host "3. SSM managed instances (Wavelength must appear here for Lambda to start agent)" -ForegroundColor Yellow
$ssm = aws ssm describe-instance-information --region $Region --query "InstanceInformationList[*].{Id:InstanceId,Ping:PingStatus,Agent:AgentVersion}" --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Error: $ssm"
} else {
    $ssmList = $ssm | ConvertFrom-Json
    foreach ($s in $ssmList) {
        $status = if ($s.Ping -eq "Online") { "Online" } else { $s.Ping }
        Write-Host "   $($s.Id)  Ping: $status  Agent: $($s.Agent)"
    }
    if ($ssmList.Count -eq 0) {
        Write-Host "   No instances in SSM. Wavelength EC2 needs SSM agent and IAM role; check user_data and instance profile."
    }
}
Write-Host ""

# 4) Check agent on Wavelength (if we have instance ID from Lambda)
if ($script:WavelengthInstanceId) {
    Write-Host "4. Agent process and log on Wavelength instance $script:WavelengthInstanceId" -ForegroundColor Yellow
    Write-Host "   Running SSM SendCommand to check /var/log/rdi-agent.log and rdi-agent process..."
    $cmdId = aws ssm send-command --region $Region --instance-ids $script:WavelengthInstanceId `
        --document-name "AWS-RunShellScript" `
        --parameters 'commands=["pgrep -a rdi-agent || true","tail -20 /var/log/rdi-agent.log 2>/dev/null || echo no log"]' `
        --query "Command.CommandId" --output text 2>&1
    if ($LASTEXITCODE -eq 0 -and $cmdId) {
        Start-Sleep -Seconds 3
        $out = aws ssm get-command-invocation --region $Region --command-id $cmdId --instance-id $script:WavelengthInstanceId --query "[Status,StandardOutputContent]" --output text 2>&1
        Write-Host "   Command status + output:"
        Write-Host "   $out"
      } else {
        Write-Host "   SendCommand failed (instance not in SSM or no permission): $cmdId"
    }
} else {
    Write-Host "4. Skip agent check (no WAVELENGTH_INSTANCE_ID in Lambda)." -ForegroundColor Gray
}
Write-Host ""
Write-Host "=== Done. See docs/AGENT-WAVELENGTH-DIAGNOSTIC.md for next steps. ===" -ForegroundColor Cyan
