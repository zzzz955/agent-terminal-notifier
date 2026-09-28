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
    if (-not $repository -and -not $Local) { Write-Host 'No GitHub origin configured. Building this local checkout. Add origin to enable release updates.' }
    & (Join-Path $SourceRoot 'scripts/pipeline.ps1') -Runtime $Runtime -Install
    return
}
Write-Host "Checking latest stable release: $repository"
$release = Get-LatestRelease $repository
if (-not $release) {
    if ($installed) { Write-Host 'No accessible published release found. Keeping the existing installation.'; return }
    throw 'No accessible published release found. Publish a release first, use GH_TOKEN for a private repository, or use apply.bat -Local.'
}
$asset = Get-ReleaseAsset $release $Runtime
$hash = $asset.digest.Substring(7)
$decision = Get-UpdateDecision $(if ($installed) { $installed.version } else { '' }) $release.tag_name $(if ($installed -and $installed.runtime -eq $Runtime -and $installed.repository -eq $repository) { $installed.artifactSha256 } else { '' }) $hash
if ($decision -in @('current','keep-newer') -and $installed.runtime -eq $Runtime -and $installed.repository -eq $repository) {
    Write-Host "Already up to date (installed $($installed.version), latest $($release.tag_name))."
    return
}
if ($decision -eq 'keep-newer') { throw 'Latest release would downgrade this installation. Existing version retained.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command code.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ and VSCode code.cmd are required.' }
$stage = Join-Path $installRoot ('updates/' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$zip = Join-Path $stage $asset.name
Write-Host "Downloading $($release.tag_name) ($Runtime)"
try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.github.com/repos/$repository/releases/assets/$($asset.id)" -Headers (Get-GitHubHeaders 'application/octet-stream') -OutFile $zip -TimeoutSec 300
} catch { throw 'Release download failed. Existing installation was not changed.' }
Assert-FileDigest $zip $hash
$bundle = Join-Path $stage 'package'
$null = Expand-VerifiedPackage $zip $bundle $release.tag_name $Runtime
Write-Host 'Release archive and all bundled file hashes verified.'
& (Join-Path $bundle 'scripts/install.ps1') -Repository $repository -ArtifactSha256 $hash
