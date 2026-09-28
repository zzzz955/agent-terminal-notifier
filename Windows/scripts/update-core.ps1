function Get-StableVersion([string]$Value) {
    if ($Value -notmatch '^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Invalid stable SemVer: $Value" }
    return [Version]::Parse($Value.TrimStart('v'))
}

function Get-UpdateDecision([string]$Installed, [string]$Latest, [string]$InstalledHash, [string]$LatestHash) {
    $new = Get-StableVersion $Latest
    if (-not $Installed) { return 'install' }
    $old = Get-StableVersion $Installed
    if ($new -lt $old) { return 'keep-newer' }
    if ($new -eq $old) {
        if ($InstalledHash -and $LatestHash -and $InstalledHash -ne $LatestHash) { throw 'Same version has a different release digest. Publish a new version instead of replacing release assets.' }
        return 'current'
    }
    return 'update'
}

function Get-ReleaseRepository([string]$WindowsRoot, $Installed) {
    $configFile = Join-Path $WindowsRoot 'release.json'
    $repository = if (Test-Path -LiteralPath $configFile) { (Get-Content -LiteralPath $configFile -Encoding UTF8 -Raw | ConvertFrom-Json).repository } else { '' }
    if (-not $repository -and $Installed) { $repository = $Installed.repository }
    if (-not $repository -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $remote = & git -C (Split-Path $WindowsRoot -Parent) remote -v 2>$null
        $origin = $remote | Where-Object { $_ -match '^origin\s+' } | Select-Object -First 1
        if ($origin -match '^origin\s+(?:https://github\.com/|git@github\.com:)([^\s]+)') { $repository = $Matches[1] -replace '\.git$', '' }
    }
    if ($repository -and $repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Release repository must be owner/repo on github.com.' }
    return $repository
}

function Get-GitHubHeaders([string]$Accept = 'application/vnd.github+json') {
    $headers = @{ Accept = $Accept; 'User-Agent' = 'AgentTerminalNotifier-Updater'; 'X-GitHub-Api-Version' = '2026-03-10' }
    $token = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
    if ($token) { $headers.Authorization = 'Bearer ' + $token }
    return $headers
}

function Get-LatestRelease([string]$Repository) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers (Get-GitHubHeaders) -TimeoutSec 30
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }
        throw 'Could not check GitHub Releases. Existing installation was not changed. Check connectivity, rate limits or GH_TOKEN for a private repository.'
    }
}

function Get-ReleaseAsset($Release, [string]$Runtime) {
    if ($Release.draft -or $Release.prerelease) { throw 'Only published stable releases may be installed.' }
    $null = Get-StableVersion $Release.tag_name
    $name = "agent-terminal-notifier-windows-$Runtime.zip"
    $matches = @($Release.assets | Where-Object { $_.name -eq $name -and $_.state -eq 'uploaded' })
    if ($matches.Count -ne 1) { throw "Release asset missing or ambiguous: $name" }
    $asset = $matches[0]
    if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'GitHub asset SHA-256 digest is missing; refusing an unverified download.' }
    if ([long]$asset.id -le 0) { throw 'Invalid release asset ID.' }
    return $asset
}

function Assert-FileDigest([string]$File, [string]$Sha256) {
    if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Sha256) { throw 'Release SHA-256 mismatch. Nothing was installed.' }
}

function Expand-VerifiedPackage([string]$Zip, [string]$Destination, [string]$Version, [string]$Runtime) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    if (Test-Path -LiteralPath $Destination) { throw 'Extraction directory must be new.' }
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('/', '\')
            $target = [IO.Path]::GetFullPath((Join-Path $root $name))
            if ([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or -not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($target)) { throw 'Unsafe or duplicate path in release ZIP.' }
            if (($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'Symlinks are not allowed in release ZIP.' }
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
    } finally { $archive.Dispose() }
    $manifestFile = Join-Path $Destination 'bundle-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or (Get-StableVersion $manifest.version) -ne (Get-StableVersion $Version) -or $manifest.runtime -ne $Runtime) { throw 'Release manifest version or architecture mismatch.' }
    $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $manifest.files) {
        $target = [IO.Path]::GetFullPath((Join-Path $root $file.path))
        if ([IO.Path]::IsPathRooted($file.path) -or $file.path.Contains(':') -or -not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not $files.Add($target)) { throw 'Unsafe or duplicate manifest file path.' }
        Assert-FileDigest $target $file.sha256
    }
    foreach ($file in Get-ChildItem -LiteralPath $Destination -File -Recurse) {
        if ($file.FullName -ne [IO.Path]::GetFullPath($manifestFile) -and -not $files.Contains($file.FullName)) { throw ('Unlisted file in release package: ' + $file.Name) }
    }
    foreach ($required in @('scripts/install.ps1','scripts/install-core.ps1','scripts/config.cjs','scripts/console.ps1','scripts/apply.ps1','scripts/update-core.ps1','scripts/sounds.ps1','extension/package.json','dist/build.json','dist/bin/AgentTerminalNotifier.exe','dist/agent-terminal-notifier.vsix')) {
        if (-not $files.Contains([IO.Path]::GetFullPath((Join-Path $root $required)))) { throw "Required release file missing: $required" }
    }
    $package = Get-Content -LiteralPath (Join-Path $Destination 'extension/package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ((Get-StableVersion $package.version) -ne (Get-StableVersion $Version)) { throw 'VSCode package version mismatch.' }
    $build = Get-Content -LiteralPath (Join-Path $Destination 'dist/build.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ((Get-StableVersion $build.version) -ne (Get-StableVersion $Version) -or $build.runtime -ne $Runtime) { throw 'Build version or architecture mismatch.' }
    return $manifest
}
