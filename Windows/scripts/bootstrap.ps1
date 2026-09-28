[CmdletBinding()]
param([string]$SourceRoot = (Split-Path $PSScriptRoot -Parent), [switch]$Local,
    [ValidateSet('win-x64','win-arm64')][string]$Runtime = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }))
$ErrorActionPreference = 'Stop'
$installedUpdater = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier/updater/apply.ps1'
$apply = if (Test-Path -LiteralPath $installedUpdater) { $installedUpdater } else { Join-Path $PSScriptRoot 'apply.ps1' }
& $apply -SourceRoot $SourceRoot -Runtime $Runtime -Local:$Local
