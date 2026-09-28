[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'console.ps1')
$installRoot = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier'
$exe = Join-Path $installRoot 'bin/AgentTerminalNotifier.exe'
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed (exit $LASTEXITCODE)." }
}
$backup = Join-Path $installRoot ('backups/uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'config.cjs'), 'remove', $exe, $backup)
if (Test-Path -LiteralPath $exe) { Invoke-Checked $exe @('unregister') }
Invoke-Checked 'code.cmd' @('--uninstall-extension', 'local-tools.agent-terminal-notifier')
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$stateFile = Join-Path $installRoot 'installed.json'
if (Test-Path -LiteralPath $stateFile) { Move-Item -LiteralPath $stateFile -Destination (Join-Path $backup 'installed.json') }
Write-Host "Removed hooks, protocol and extension. Backup, WAV and build files retained at $installRoot. Reload VSCode and restart agents."
