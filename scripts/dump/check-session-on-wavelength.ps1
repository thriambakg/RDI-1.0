# Check if a session ID exists on the Wavelength agent by trying to add it (POST only; never deletes).
# Agent returns 409 "already exists" if session is there, 201 "added" if it was not.
#
# Usage: .\check-session-on-wavelength.ps1 -SessionId "your-session-id-uuid"
# Optional: -InstanceId i-xxx (default: from Lambda env or prompt)

param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,
    [string]$InstanceId = "",
    [string]$ProxyUrl = "wss://wss.rdistaging.com",
    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

if (-not $InstanceId) {
    $fn = "rdi-session-api-staging-$Region"
    $cfg = aws lambda get-function-configuration --region $Region --function-name $fn --query "Environment.Variables" --output json 2>&1
    if ($LASTEXITCODE -eq 0) {
        $vars = $cfg | ConvertFrom-Json
        $InstanceId = $vars.WAVELENGTH_INSTANCE_ID
    }
}
if (-not $InstanceId) {
    Write-Host "Provide -InstanceId (e.g. i-043669089dcbb2d0e) or ensure Lambda $fn has WAVELENGTH_INSTANCE_ID." -ForegroundColor Red
    exit 1
}

$body = @{ session_id = $SessionId; proxy_url = $ProxyUrl } | ConvertTo-Json -Compress
$bashEscaped = $body.Replace("'", "'\''")
$cmd1 = "echo '" + $bashEscaped + "' > /tmp/session-check.json"
$cmd2 = "curl -s -w '\nHTTP_CODE:%{http_code}' -X POST http://127.0.0.1:8080/sessions -H 'Content-Type: application/json' -d @/tmp/session-check.json"

$params = @{ commands = @($cmd1, $cmd2) }
$paramsFile = [System.IO.Path]::GetTempFileName()
$params | ConvertTo-Json -Depth 3 | Set-Content -Path $paramsFile -Encoding UTF8 -NoNewline
$paramsPath = "file:///" + (Resolve-Path -LiteralPath $paramsFile).Path.Replace('\', '/')

Write-Host "Checking session $SessionId on instance $InstanceId (POST only; no delete)..." -ForegroundColor Cyan
$sendResult = aws ssm send-command --region $Region --instance-ids $InstanceId `
    --document-name "AWS-RunShellScript" `
    --parameters $paramsPath `
    --query "Command.CommandId" --output text
Remove-Item -LiteralPath $paramsFile -ErrorAction SilentlyContinue

if ($LASTEXITCODE -ne 0) {
    Write-Host "SSM SendCommand failed. Check instance is SSM-managed (Online)." -ForegroundColor Red
    exit 1
}
$cmdId = $sendResult?.Trim()
if (-not $cmdId) {
    Write-Host "No CommandId returned." -ForegroundColor Red
    exit 1
}

Start-Sleep -Seconds 5
$inv = aws ssm get-command-invocation --region $Region --command-id $cmdId --instance-id $InstanceId --output json 2>&1 | ConvertFrom-Json
$out = if ($inv.StandardOutputContent) { $inv.StandardOutputContent } else { "" }

if ($inv.StandardErrorContent) { Write-Host "Stderr: $($inv.StandardErrorContent)" -ForegroundColor Yellow }
Write-Host "--- Agent response ---"
Write-Host $out

if ($out -match "already exists" -or $out -match "HTTP_CODE:409") {
    Write-Host "`nResult: Session EXISTS on Wavelength (agent returned already exists)." -ForegroundColor Green
    exit 0
}
if ($out -match "added" -or $out -match "HTTP_CODE:201") {
    Write-Host "`nResult: Session was NOT on Wavelength; agent added it (connection started). Not deleted." -ForegroundColor Yellow
    exit 0
}
Write-Host "`nResult: Could not determine (check output above)." -ForegroundColor Yellow
exit 0
