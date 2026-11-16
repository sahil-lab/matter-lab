<#
.SYNOPSIS
  Points the current terminal at a Node.js runtime that satisfies MATTER LAB (Node >= 22.12).

.DESCRIPTION
  Only this PowerShell process is affected; the globally selected Node version is left alone.
  Afterwards `node`, `npm`, `npx` and the project's local tools (vite, vitest, tsc, playwright)
  resolve to the right versions. You do not need this script if `node --version` already reports
  22.12 or newer and `npm --version` reports 10 or newer.

.EXAMPLE
  .\env.ps1
  npm install
  npm run dev
#>
param([switch] $Quiet)

function Test-NodeOk([string] $exe) {
  if (-not (Test-Path $exe)) { return $false }
  $parts = ((& $exe --version) -replace '^v', '').Split('.') | ForEach-Object { [int]$_ }
  return ($parts[0] -gt 22) -or ($parts[0] -eq 22 -and $parts[1] -ge 12)
}

$repo = $PSScriptRoot
$candidates = @()
if ($env:MATTERLAB_NODE_DIR) { $candidates += Join-Path $env:MATTERLAB_NODE_DIR 'node.exe' }
$onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($onPath) { $candidates += $onPath.Source }
foreach ($root in @($env:NVM_HOME, "$env:LOCALAPPDATA\nvm", "$env:APPDATA\nvm")) {
  if ($root -and (Test-Path $root)) {
    $candidates += Get-ChildItem $root -Directory -Filter 'v*' |
      Sort-Object { [version]($_.Name.TrimStart('v')) } -Descending |
      ForEach-Object { Join-Path $_.FullName 'node.exe' }
  }
}

$node = $candidates | Where-Object { Test-NodeOk $_ } | Select-Object -First 1
if (-not $node) {
  throw 'MATTER LAB needs Node.js >= 22.12. Install one (for example "nvm install 24") and run this script again.'
}

$nodeDir = Split-Path $node
if (-not (Test-Path (Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'))) {
  throw "npm was not found next to $node."
}

# tools\bin holds npm/npx shims that always use the npm bundled with the selected Node, which avoids
# setups where an older globally installed npm shadows it.
$env:MATTERLAB_NODE_DIR = $nodeDir
$prepend = @((Join-Path $repo 'tools\bin'), (Join-Path $repo 'node_modules\.bin'), $nodeDir)
$rest = $env:Path -split ';' | Where-Object { $_ -and ($prepend -notcontains $_) }
$env:Path = ($prepend + $rest) -join ';'

if (-not $Quiet) {
  Write-Host "MATTER LAB environment ready: Node $(& $node --version) from $nodeDir"
}
