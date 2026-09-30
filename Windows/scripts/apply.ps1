[CmdletBinding()]
param([string]$SourceRoot = (Split-Path $PSScriptRoot -Parent), [switch]$Local,
    [ValidateSet('win-x64','win-arm64')][string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'console.ps1')
. (Join-Path $PSScriptRoot 'update-core.ps1')
$installRoot = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier'
$stateFile = Join-Path $installRoot 'installed.json'
$installed = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Encoding UTF8 -Raw | ConvertFrom-Json } else { $null }
$repository = Get-ReleaseRepository $SourceRoot $installed
if ($Local -or -not $repository) {
    if (-not $repository -and -not $Local) { Write-Host 'No GitHub origin configured. Building this local checkout. Add origin to enable repository updates.' }
    & (Join-Path $SourceRoot 'scripts/pipeline.ps1') -Runtime $Runtime -Install
    return
}
$cache = Join-Path $installRoot 'source'
Write-Host "Fetching default branch: $repository"
$commit = Sync-RepositorySource $repository $cache
if ($installed -and $installed.runtime -eq $Runtime -and $installed.repository -eq $repository -and $installed.sourceCommit -and ($installed.sourceCommit -eq $commit)) {
    Show-ApplySummary -Title 'Nothing changed' -Outcome unchanged -Commit $commit -Version $installed.version -Runtime $installed.runtime -Repository $repository -ConfigScript (Join-Path $SourceRoot 'scripts/config.cjs')
    return
}
$pipeline = Join-Path $cache 'Windows/scripts/pipeline.ps1'
if (-not (Test-Path -LiteralPath $pipeline)) { throw 'Fetched repository has no Windows/scripts/pipeline.ps1. Existing installation was not changed.' }
& $pipeline -Runtime $Runtime -Install
