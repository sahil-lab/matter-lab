param([switch] $Production)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$file = Join-Path $root '.local\science-auth.json'
if (-not (Test-Path -LiteralPath $file)) { throw 'Run .\tools\start-science.ps1 before the connected browser tests.' }
$record = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
$secure = ConvertTo-SecureString $record.encryptedToken
$credential = New-Object System.Management.Automation.PSCredential('matterlab-local', $secure)
Push-Location $root
try {
  & .\env.ps1 -Quiet
  $env:MATTERLAB_E2E_SERVICE_TOKEN = $credential.GetNetworkCredential().Password
  Push-Location apps\web
  try {
    if ($Production) { playwright test --config playwright.preview.config.ts backend-live }
    else { playwright test backend-live }
    if ($LASTEXITCODE -ne 0) { throw 'Connected browser verification failed.' }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:MATTERLAB_E2E_SERVICE_TOKEN -ErrorAction SilentlyContinue
  Pop-Location
}
