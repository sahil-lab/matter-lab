<#
.SYNOPSIS
  Starts this project's PostgreSQL and science service with a private local laboratory credential.
.DESCRIPTION
  The credential is encrypted with Windows DPAPI for the current user under .local (Git-ignored).
  Only its SHA-256 hash is passed to Docker. -ShowToken displays it on explicit request for the
  browser's memory-only connection field. No machine-wide Docker restart or volume deletion occurs.
#>
param([switch] $NoBuild, [switch] $ShowToken)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $root '.local'
$file = Join-Path $directory 'science-auth.json'
if (-not (Test-Path -LiteralPath $file)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $bytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  $secret = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
  $record = @{ ownerId = [Guid]::NewGuid().ToString(); encryptedToken = ConvertFrom-SecureString $secret }
  $record | ConvertTo-Json | Set-Content -LiteralPath $file -Encoding UTF8
}
$record = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
$owner = [Guid]::Parse($record.ownerId).ToString()
$secret = ConvertTo-SecureString $record.encryptedToken
$credential = New-Object System.Management.Automation.PSCredential('matterlab-local', $secret)
$token = $credential.GetNetworkCredential().Password
if ($ShowToken) {
  Write-Output $token
  return
}
$hash = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose(); $token = $null }
$previous = $env:MATTERLAB_LAB_AUTH_TOKENS_JSON
Push-Location $root
try {
  $env:MATTERLAB_LAB_AUTH_TOKENS_JSON = ConvertTo-Json -Compress -InputObject @(
    @{ sha256 = $digest; ownerId = $owner; scopes = @('lab:read', 'lab:write', 'lab:run', 'lab:export') }
  )
  $arguments = @('compose', '-p', 'matterlab', 'up', '-d', '--wait', '--wait-timeout', '120')
  if (-not $NoBuild) { $arguments += '--build' }
  & docker @arguments db science
  if ($LASTEXITCODE -ne 0) { throw 'The science service did not start. Existing database volumes were not deleted.' }
  Write-Output 'Science service ready at http://127.0.0.1:8787.'
  Write-Output 'For the browser connection token, explicitly run: .\tools\start-science.ps1 -ShowToken'
} finally {
  $env:MATTERLAB_LAB_AUTH_TOKENS_JSON = $previous
  Pop-Location
}
