[CmdletBinding()]
param([switch]$Install, [ValidateSet('win-x64','win-arm64')][string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'console.ps1')
$windowsRoot = Split-Path $PSScriptRoot -Parent
$extensionRoot = Join-Path $windowsRoot 'extension'
$dist = Join-Path $windowsRoot 'dist'
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed (exit $LASTEXITCODE)." }
}
if ($env:OS -ne 'Windows_NT') { throw 'This pipeline supports Windows only.' }
foreach ($tool in @('node','npm.cmd','dotnet')) { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is required. See Windows/README.md." } }
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$syntaxFailures = @()
Get-ChildItem -LiteralPath $PSScriptRoot,(Join-Path $windowsRoot 'examples') -Filter '*.ps1' | ForEach-Object {
    $parseTokens = $null; $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
    $syntaxFailures += $parseErrors
}
if ($syntaxFailures.Count) { throw ($syntaxFailures | Out-String) }
& (Join-Path $PSScriptRoot 'sounds.ps1') -Directory (Join-Path $dist 'sounds') -ForceDefaults
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'verify-sounds.cjs'), (Join-Path $dist 'sounds'))
Push-Location $extensionRoot
try {
    Invoke-Checked 'npm.cmd' @('ci','--no-fund','--no-audit')
    Invoke-Checked 'npm.cmd' @('test')
    Invoke-Checked 'dotnet' @('publish', (Join-Path $windowsRoot 'notifier/AgentTerminalNotifier.csproj'), '-c','Release','-r',$Runtime,'--self-contained','true','-p:RestoreLockedMode=true','-o',(Join-Path $dist 'bin'))
    Invoke-Checked (Join-Path $dist 'bin/AgentTerminalNotifier.exe') @('self-test')
    Invoke-Checked 'node' @((Join-Path $windowsRoot 'scripts/integration-test.cjs'), (Join-Path $dist 'bin/AgentTerminalNotifier.exe'))
    Invoke-Checked 'npm.cmd' @('run','package')
} finally { Pop-Location }
Write-Host "Build and automated checks passed: $dist"
if ($Install) { & (Join-Path $PSScriptRoot 'install.ps1') }
