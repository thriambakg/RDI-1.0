# Add a session to the RDI agent daemon on the Wavelength instance (Option A: daemon + local API).
# Use when: "Proxy reached; no agent on Wavelength instance" — session create didn't add the session
# (e.g. SSM failed). The agent daemon must already be running on the instance (started at boot).
#
# Usage: .\start-agent-on-wavelength.ps1 -SessionId "your-session-id-from-app"
# Optional: -InstanceId i-xxx -ProxyUrl "wss://wss.rdistaging.com" (default: from Lambda env)

param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,
    [string]$InstanceId = "",
    [string]$ProxyUrl = "",
    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

if (-not $InstanceId -or -not $ProxyUrl) {
    $fn = "rdi-session-api-staging-$Region"
    $cfg = aws lambda get-function-configuration --region $Region --function-name $fn --query "Environment.Variables" --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not get Lambda env (is $fn deployed?). Provide -InstanceId and -ProxyUrl." -ForegroundColor Red
        exit 1
    }
    $vars = $cfg | ConvertFrom-Json
    if (-not $InstanceId) { $InstanceId = $vars.WAVELENGTH_INSTANCE_ID }
    if (-not $ProxyUrl)   { $ProxyUrl   = $vars.PROXY_ENDPOINT }
}

if (-not $InstanceId -or -not $ProxyUrl) {
    Write-Host "Missing WAVELENGTH_INSTANCE_ID or PROXY_ENDPOINT. Set Lambda env or pass -InstanceId and -ProxyUrl." -ForegroundColor Red
    exit 1
}

# Agent daemon API: POST http://127.0.0.1:8080/sessions with JSON body. Use file on instance to avoid quoting.
$body = @{ session_id = $SessionId; proxy_url = $ProxyUrl } | ConvertTo-Json -Compress
$bashEscaped = $body.Replace("'", "'\''")
$cmd1 = "echo '" + $bashEscaped + "' > /tmp/session-add.json"
$cmd2 = "curl -s -X POST http://127.0.0.1:8080/sessions -H 'Content-Type: application/json' -d @/tmp/session-add.json"

$params = @{ commands = @($cmd1, $cmd2) }
$paramsFile = [System.IO.Path]::GetTempFileName()
$params | ConvertTo-Json -Depth 3 | Set-Content -Path $paramsFile -Encoding UTF8 -NoNewline
# AWS CLI on Windows: use absolute path with forward slashes for file://
$paramsPath = "file:///" + (Resolve-Path -LiteralPath $paramsFile).Path.Replace('\', '/')

Write-Host "Adding session to agent daemon on $InstanceId (session $SessionId, proxy $ProxyUrl)..." -ForegroundColor Cyan
$sendResult = aws ssm send-command --region $Region --instance-ids $InstanceId `
    --document-name "AWS-RunShellScript" `
    --parameters $paramsPath `
    --query "Command.CommandId" --output text
Remove-Item -LiteralPath $paramsFile -ErrorAction SilentlyContinue

if ($LASTEXITCODE -ne 0) {
    Write-Host "SSM SendCommand failed (exit $LASTEXITCODE). Check AWS credentials and that instance $InstanceId is SSM-managed (Online)." -ForegroundColor Red
    exit 1
}
$cmdId = $sendResult?.Trim()
if (-not $cmdId) {
    Write-Host "SSM SendCommand returned no CommandId." -ForegroundColor Red
    exit 1
}

Write-Host "Command sent. CommandId: $cmdId" -ForegroundColor Green
Write-Host "Waiting 4s then checking result..."
Start-Sleep -Seconds 4
$inv = aws ssm get-command-invocation --region $Region --command-id $cmdId --instance-id $InstanceId --output json 2>&1 | ConvertFrom-Json
Write-Host "Status: $($inv.Status)"
if ($inv.StandardOutputContent) { Write-Host $inv.StandardOutputContent }
if ($inv.StandardErrorContent)  { Write-Host "Stderr: $($inv.StandardErrorContent)" -ForegroundColor Yellow }
if ($inv.Status -eq "Success") {
    Write-Host "Session added. Ping again from the app (same session)." -ForegroundColor Green
} else {
    Write-Host "Ensure the agent daemon is running on the instance (nohup /opt/rdi-agent/rdi-agent ...)." -ForegroundColor Yellow
}
