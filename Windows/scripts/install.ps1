[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$windowsRoot = Split-Path $PSScriptRoot -Parent
$installRoot = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier'
$exe = Join-Path $installRoot 'bin/AgentTerminalNotifier.exe'
$vsix = Join-Path $windowsRoot 'dist/agent-terminal-notifier.vsix'
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed (exit $LASTEXITCODE)." }
}
if (-not (Get-Command code.cmd -ErrorAction SilentlyContinue)) { throw 'VSCode code.cmd must be on PATH.' }
if (-not (Test-Path -LiteralPath $vsix)) { throw 'Run pipeline.ps1 first.' }
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'config.cjs'), 'check', $exe)
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $windowsRoot 'dist/bin') -Destination $installRoot -Recurse -Force
& (Join-Path $PSScriptRoot 'sounds.ps1') -Directory (Join-Path $installRoot 'sounds')
Invoke-Checked $exe @('register')
Invoke-Checked 'code.cmd' @('--install-extension', $vsix, '--force')
$backup = Join-Path $installRoot ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'config.cjs'), 'install', $exe, $backup)
Write-Host 'Installed. Reload every VSCode window, restart Codex/Claude sessions, then run Agent Notifier: Test Active Terminal.'
