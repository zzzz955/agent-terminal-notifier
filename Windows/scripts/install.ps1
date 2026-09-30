[CmdletBinding()]
param([string]$Repository = '', [string]$ArtifactSha256 = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'console.ps1')
. (Join-Path $PSScriptRoot 'update-core.ps1')
. (Join-Path $PSScriptRoot 'install-core.ps1')
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
$build = Get-Content -LiteralPath (Join-Path $windowsRoot 'dist/build.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$version = Get-StableVersion $build.version
if ($ArtifactSha256 -and $ArtifactSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid artifact SHA-256.' }
$stateFile = Join-Path $installRoot 'installed.json'
$previous = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Encoding UTF8 -Raw | ConvertFrom-Json } else { $null }
if ($previous -and $version -lt (Get-StableVersion $previous.version)) { throw 'Refusing to downgrade the installed application.' }
if (-not $Repository) { $Repository = Get-ReleaseRepository $windowsRoot $previous }
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'config.cjs'), 'check', $exe)
Invoke-Checked (Join-Path $windowsRoot 'dist/bin/AgentTerminalNotifier.exe') @('self-test')
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$lock = [Threading.Mutex]::new($false, ('Local\AgentTerminalNotifier-Install-' + [Environment]::UserName))
if (-not $lock.WaitOne(0)) { $lock.Dispose(); throw 'Another install/update is running.' }
$backup = Join-Path $installRoot ('backups/install-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid())
$configBackup = Join-Path $backup 'config'
$staging = Join-Path $backup 'new-bin'
$oldVsix = Join-Path $backup 'previous.vsix'
$oldExtension = $false
$extensionChanged = $false
$binMoved = $false
$snapshotReady = $false
$registered = $false
$hadBin = Test-Path -LiteralPath (Join-Path $installRoot 'bin')
$hadSounds = Test-Path -LiteralPath (Join-Path $installRoot 'sounds')
$hadUpdater = Test-Path -LiteralPath (Join-Path $installRoot 'updater')
try {
    if (Test-Path -LiteralPath $stateFile) {
        $current = Get-Content -LiteralPath $stateFile -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($version -lt (Get-StableVersion $current.version)) { throw 'Refusing to downgrade the installed application.' }
    }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $oldExtension = Save-InstalledVsix $oldVsix
    foreach ($file in @('installed.json','extension.vsix')) {
        if (Test-Path -LiteralPath (Join-Path $installRoot $file)) { Copy-Item -LiteralPath (Join-Path $installRoot $file) -Destination $backup }
    }
    if ($hadSounds) { Copy-Item -LiteralPath (Join-Path $installRoot 'sounds') -Destination $backup -Recurse }
    Copy-Item -LiteralPath (Join-Path $windowsRoot 'dist/bin') -Destination $staging -Recurse
    $snapshotReady = $true
    if ($hadBin) { Move-InstallDirectory (Join-Path $installRoot 'bin') (Join-Path $backup 'bin') $installRoot }
    $binMoved = $true
    Move-InstallDirectory $staging (Join-Path $installRoot 'bin') $installRoot
    $registered = $true
    Invoke-Checked $exe @('register')
    & (Join-Path $PSScriptRoot 'sounds.ps1') -Directory (Join-Path $installRoot 'sounds')
    $extensionChanged = $true
    Invoke-Checked 'code.cmd' @('--install-extension', $vsix, '--force')
    Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'config.cjs'), 'install', $exe, $configBackup)
    if ($hadUpdater) { Move-InstallDirectory (Join-Path $installRoot 'updater') (Join-Path $backup 'updater') $installRoot }
    New-Item -ItemType Directory -Path (Join-Path $installRoot 'updater') -Force | Out-Null
    foreach ($file in @('apply.ps1','update-core.ps1','console.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $installRoot 'updater') }
    Copy-Item -LiteralPath $vsix -Destination (Join-Path $installRoot 'extension.vsix') -Force
    $state = @{ version = $build.version; runtime = $build.runtime; repository = $Repository; artifactSha256 = $ArtifactSha256; sourceCommit = $build.sourceCommit; installedAt = [DateTimeOffset]::Now.ToString('O') }
    [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $changedAgents = @()
    $manifestPath = Join-Path $configBackup 'manifest.json'
    if (Test-Path -LiteralPath $manifestPath) {
        foreach ($entry in (Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json)) {
            if ($entry.agent) { $changedAgents += $entry.agent }
        }
    }
    Show-ApplySummary -Title "Installed $($build.version)" -Outcome changed -Commit $build.sourceCommit -Version $build.version -Runtime $build.runtime -Repository $Repository -ChangedAgents $changedAgents -ConfigScript (Join-Path $PSScriptRoot 'config.cjs') -PreviousCommit $(if ($previous) { $previous.sourceCommit } else { '' }) -PreviousVersion $(if ($previous) { $previous.version } else { '' }) -Backup $backup
} catch {
    $failure = $_
    if (-not $snapshotReady) { throw }
    try {
        Restore-ConfigBackup $configBackup
        if ($extensionChanged) {
            if ($oldExtension) { Invoke-Checked 'code.cmd' @('--install-extension', $oldVsix, '--force') }
            else { Invoke-Checked 'code.cmd' @('--uninstall-extension', 'local-tools.agent-terminal-notifier') }
        }
        if ($registered -and -not $hadBin) { Invoke-Checked $exe @('unregister') }
        if ($binMoved) {
            if (Test-Path -LiteralPath (Join-Path $installRoot 'bin')) { Move-InstallDirectory (Join-Path $installRoot 'bin') (Join-Path $backup 'failed-bin') $installRoot }
            if ($hadBin) { Move-InstallDirectory (Join-Path $backup 'bin') (Join-Path $installRoot 'bin') $installRoot }
        }
        foreach ($directory in @('sounds','updater')) {
            if (Test-Path -LiteralPath (Join-Path $backup $directory)) {
                if (Test-Path -LiteralPath (Join-Path $installRoot $directory)) { Move-InstallDirectory (Join-Path $installRoot $directory) (Join-Path $backup ('failed-' + $directory)) $installRoot }
                Copy-Item -LiteralPath (Join-Path $backup $directory) -Destination $installRoot -Recurse
            } elseif (($directory -eq 'sounds' -and -not $hadSounds) -or ($directory -eq 'updater' -and -not $hadUpdater)) {
                if (Test-Path -LiteralPath (Join-Path $installRoot $directory)) { Move-InstallDirectory (Join-Path $installRoot $directory) (Join-Path $backup ('failed-' + $directory)) $installRoot }
            }
        }
        foreach ($file in @('installed.json','extension.vsix')) {
            if (Test-Path -LiteralPath (Join-Path $backup $file)) { Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $installRoot $file) -Force }
            elseif (Test-Path -LiteralPath (Join-Path $installRoot $file)) { Remove-Item -LiteralPath (Join-Path $installRoot $file) -Force }
        }
        Write-Host 'Install failed; previous files, settings and extension restored.'
    } catch { Write-Warning "Automatic rollback could not finish. Recovery files: $backup" }
    throw $failure
} finally { $lock.ReleaseMutex(); $lock.Dispose() }
