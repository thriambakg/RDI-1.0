# WebSocket / ALB diagnostic checks via AWS CLI
# Run from RDI-1.0 with AWS CLI configured and network access.
# Staging uses us-east-1; override with $env:AWS_REGION or -Region.

param(
    [string]$Region = $env:AWS_REGION
)
if (-not $Region) { $Region = "us-east-1" }
$env:AWS_DEFAULT_REGION = $Region

Write-Host "=== WebSocket ALB checks (region: $Region) ===" -ForegroundColor Cyan
Write-Host ""

# 1) Target groups and target health
Write-Host "1. Target groups (rdi + staging)" -ForegroundColor Yellow
$tgs = aws elbv2 describe-target-groups --region $Region `
    --query "TargetGroups[?contains(TargetGroupName, 'rdi') && contains(TargetGroupName, 'staging')].{Name:TargetGroupName,Arn:TargetGroupArn,Port:Port}" `
    --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Error: $tgs"
} else {
    $tgList = $tgs | ConvertFrom-Json
    if ($tgList.Count -eq 0) {
        Write-Host "   No target groups found."
    } else {
        foreach ($tg in $tgList) {
            Write-Host "   TG: $($tg.Name)  Port: $($tg.Port)"
            $health = aws elbv2 describe-target-health --region $Region --target-group-arn $tg.Arn --output json 2>&1
            if ($LASTEXITCODE -eq 0) {
                $h = $health | ConvertFrom-Json
                foreach ($desc in $h.TargetHealthDescriptions) {
                    $state = $desc.TargetHealth.State
                    $reason = $desc.TargetHealth.Reason
                    $reasonCode = $desc.TargetHealth.ReasonCode
                    $color = if ($state -eq "healthy") { "Green" } else { "Red" }
                    Write-Host "     Target $($desc.Target.Id):$($desc.Target.Port) -> $state" -ForegroundColor $color
                    if ($reason) { Write-Host "       Reason: $reason ($reasonCode)" }
                }
            } else {
                Write-Host "     Error getting health: $health"
            }
        }
    }
}
Write-Host ""

# 2) Load balancers and listeners (HTTPS 443)
Write-Host "2. Load balancers and listeners (HTTPS 443 required for wss://)" -ForegroundColor Yellow
$albs = aws elbv2 describe-load-balancers --region $Region `
    --query "LoadBalancers[?contains(LoadBalancerName, 'rdi')].{Name:LoadBalancerName,Arn:LoadBalancerArn,DNS:DNSName}" `
    --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Error: $albs"
} else {
    $albList = $albs | ConvertFrom-Json
    if ($albList.Count -eq 0) {
        Write-Host "   No load balancers found."
    } else {
        foreach ($alb in $albList) {
            Write-Host "   ALB: $($alb.Name)  DNS: $($alb.DNS)"
            $listeners = aws elbv2 describe-listeners --region $Region --load-balancer-arn $alb.Arn `
                --query "Listeners[*].{Port:Port,Protocol:Protocol}" --output json 2>&1
            if ($LASTEXITCODE -eq 0) {
                $lis = $listeners | ConvertFrom-Json
                foreach ($l in $lis) {
                    $ok = ($l.Protocol -eq "HTTPS" -and [int]$l.Port -eq 443)
                    $c = if ($ok) { "Green" } else { "Gray" }
                    Write-Host "     Listener $($l.Port) $($l.Protocol)" -ForegroundColor $c
                }
            } else {
                Write-Host "     Error: $listeners"
            }
        }
    }
}
Write-Host ""

# 3) ALB security group egress (8765, 8766)
Write-Host "3. ALB security group egress (need 8765 and 8766 to VPC)" -ForegroundColor Yellow
$sgList = aws ec2 describe-security-groups --region $Region `
    --filters "Name=group-name,Values=rdi-alb-sg*" "Name=vpc-id,Values=*" `
    --query "SecurityGroups[*].{GroupId:GroupId,GroupName:GroupName}" --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Error: $sgList"
} else {
    $sgs = $sgList | ConvertFrom-Json
    foreach ($sg in $sgs) {
        Write-Host "   SG: $($sg.GroupName) ($($sg.GroupId))"
        $egress = aws ec2 describe-security-groups --region $Region --group-ids $sg.GroupId `
            --query "SecurityGroups[0].IpPermissionsEgress[*].{From:FromPort,To:ToPort,IpRanges:IpRanges[0].CidrIp}" --output json 2>&1
        if ($LASTEXITCODE -eq 0) {
            $eg = $egress | ConvertFrom-Json
            $has8765 = $false; $has8766 = $false
            foreach ($e in $eg) {
                if ($e.From -eq 8765 -and $e.To -eq 8765) { $has8765 = $true }
                if ($e.From -eq 8766 -and $e.To -eq 8766) { $has8766 = $true }
                Write-Host "     Egress: port $($e.From)-$($e.To) -> $($e.IpRanges)"
            }
            if (-not $has8765) { Write-Host "     Missing egress 8765" -ForegroundColor Red }
            if (-not $has8766) { Write-Host "     Missing egress 8766 (health check)" -ForegroundColor Red }
        }
    }
}
Write-Host ""

# 4) Proxy security group ingress (8766 from VPC)
Write-Host "4. Proxy security group ingress (8766 for ALB health checks)" -ForegroundColor Yellow
$proxySgs = aws ec2 describe-security-groups --region $Region `
    --filters "Name=group-name,Values=rdi*proxy*" "Name=vpc-id,Values=*" `
    --query "SecurityGroups[*].{GroupId:GroupId,GroupName:GroupName}" --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Error: $proxySgs"
} else {
    $psgs = $proxySgs | ConvertFrom-Json
    foreach ($sg in $psgs) {
        Write-Host "   SG: $($sg.GroupName) ($($sg.GroupId))"
        $ingress = aws ec2 describe-security-groups --region $Region --group-ids $sg.GroupId `
            --query "SecurityGroups[0].IpPermissions[?FromPort!=null].[FromPort,ToPort,IpRanges[0].CidrIp]" --output json 2>&1
        if ($LASTEXITCODE -eq 0) {
            $in = $ingress | ConvertFrom-Json
            foreach ($i in $in) {
                $from = $i[0]; $to = $i[1]; $cidr = $i[2]
                $mark = if ($from -eq 8766) { " (health)" } else { "" }
                Write-Host "     Ingress: port $from-$to from $cidr$mark"
            }
        }
    }
}
Write-Host ""

# 5) DNS for wss.rdistaging.com
Write-Host "5. DNS for wss.rdistaging.com" -ForegroundColor Yellow
$dns = Resolve-DnsName -Name "wss.rdistaging.com" -ErrorAction SilentlyContinue
if ($dns) {
    Write-Host "   $($dns | ForEach-Object { $_.IPAddress } | Sort-Object -Unique)"
} else {
    Write-Host "   Resolution failed or no A/AAAA record."
}
Write-Host ""

# 6) TLS connectivity (optional)
Write-Host "6. TLS to wss.rdistaging.com:443" -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest -Uri "https://wss.rdistaging.com/" -Method Head -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-Host "   HTTPS status: $($r.StatusCode) (connection OK)"
} catch {
    Write-Host "   Request failed: $($_.Exception.Message)"
    Write-Host "   Or try: curl.exe -vI --connect-timeout 10 https://wss.rdistaging.com/"
}
Write-Host ""
Write-Host "=== Done. See docs/WEBSOCKET-ALB-DIAGNOSTIC.md for fixes. ===" -ForegroundColor Cyan
