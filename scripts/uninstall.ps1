#requires -RunAsAdministrator
param(
  [switch]$PurgeData
)
$ErrorActionPreference = "Stop"

$ConfigDir = "C:\ProgramData\FazaiHub"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "FAZAI Hub uninstall (elevated)"
Set-Location $Root

Write-Host "[1/3] stop and remove service"
npm run service:uninstall
if ($LASTEXITCODE -ne 0) { Write-Warning "service uninstall returned non-zero; continuing" }

Write-Host "[2/3] remove firewall rule"
netsh advfirewall firewall delete rule name="Fazai Hub" | Out-Null

if ($PurgeData) {
  $confirm = Read-Host "Type PURGE DATA to permanently delete $ConfigDir"
  if ($confirm -ne "PURGE DATA") {
    throw "Confirmation failed; data preserved."
  }
  Write-Host "[3/3] purging data"
  Remove-Item -Recurse -Force $ConfigDir
} else {
  Write-Host "[3/3] data preserved at $ConfigDir"
}

Write-Host "Done."
