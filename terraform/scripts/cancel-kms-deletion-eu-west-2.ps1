# Cancel KMS key deletion in eu-west-2 to unblock Lambda layer uploads
# Run with: $env:AWS_PROFILE = "RDI-Admin"; .\scripts\cancel-kms-deletion-eu-west-2.ps1

$KeyId = "6cf8bd95-9f8c-4015-b7b3-49c44bdf7f57"
$Region = "eu-west-2"

Write-Host "Canceling KMS key deletion in $Region..."
aws kms cancel-key-deletion --key-id $KeyId --region $Region
if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed. If the key is past the cancellation window (7-30 days), you'll need to create a new key and migrate." -ForegroundColor Red
  exit 1
}
Write-Host "Success. Key is no longer pending deletion. Re-run the deployment."
