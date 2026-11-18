#requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ConfigDir = "C:\ProgramData\DBHub"
$ConfigPath = Join-Path $ConfigDir "config.json"
$DataDir = Join-Path $ConfigDir "data"
$LogDir = Join-Path $ConfigDir "logs"

Write-Host "DBHub install (elevated)"
Set-Location $Root

Write-Host "[1/6] npm ci"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

Write-Host "[2/6] npm run build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "[3/6] create directories"
New-Item -ItemType Directory -Force -Path $ConfigDir, $DataDir, $LogDir | Out-Null

if (-not (Test-Path $ConfigPath)) {
  Write-Host "[4/6] generate config (admin token printed once)"
  $env:DBHUB_CONFIG = $ConfigPath
  node scripts/config-init.mjs $ConfigPath
  if ($LASTEXITCODE -ne 0) { throw "config init failed" }
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $cfg.dataDir = $DataDir
  $cfg.logDir = $LogDir
  $cfg.port = 8787
  $cfg.host = "0.0.0.0"
  $cfg | ConvertTo-Json -Depth 10 | Set-Content $ConfigPath
} else {
  Write-Host "[4/6] config already exists; keeping it"
}
$env:DBHUB_CONFIG = $ConfigPath

Write-Host "[5/6] install and start Windows service"
npm run service:install
if ($LASTEXITCODE -ne 0) { throw "service install failed" }

Write-Host "[6/6] add firewall rule"
netsh advfirewall firewall delete rule name="DBHub" | Out-Null
netsh advfirewall firewall add rule name="DBHub" dir=in action=allow protocol=TCP localport=8787
if ($LASTEXITCODE -ne 0) { throw "firewall rule failed" }

Write-Host "[7/7] verify service"
$svc = sc.exe query dbhub.exe
if ($LASTEXITCODE -ne 0) { throw "service query failed" }
if ($svc -notmatch "RUNNING") { throw "DBHub service is not RUNNING" }
$svc
Write-Host "Done. Check with: sc.exe query dbhub.exe"
