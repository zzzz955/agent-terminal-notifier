[CmdletBinding()]
param([ValidateSet('win-x64','win-arm64')][string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/console.ps1')
. (Join-Path $PSScriptRoot 'scripts/update-core.ps1')
$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension/package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$null = Get-StableVersion $package.version
& (Join-Path $PSScriptRoot 'scripts/pipeline.ps1') -Runtime $Runtime
$build = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dist/build.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$stage = Join-Path $PSScriptRoot ('dist/release-stage-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path "$stage/extension/node_modules","$stage/assets/sfx","$stage/dist" -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'scripts') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'extension/package.json') -Destination "$stage/extension"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'extension/node_modules/smol-toml') -Destination "$stage/extension/node_modules" -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets/sfx/manifest.json') -Destination "$stage/assets/sfx"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets/sfx/optimized') -Destination "$stage/assets/sfx" -Recurse
foreach ($file in @('bin','agent-terminal-notifier.vsix','build.json')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('dist/' + $file)) -Destination "$stage/dist" -Recurse }
$manifest = @{ schemaVersion = 1; version = $build.version; runtime = $Runtime; sourceCommit = $build.sourceCommit; files = @() }
foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) {
    $manifest.files += @{ path = $file.FullName.Substring($stage.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[IO.File]::WriteAllText((Join-Path $stage 'bundle-manifest.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$out = Join-Path $PSScriptRoot "dist/releases/v$($build.version)"
New-Item -ItemType Directory -Path $out -Force | Out-Null
$zip = Join-Path $out "agent-terminal-notifier-windows-$Runtime.zip"
if (Test-Path -LiteralPath $zip) { throw "Release package already exists: $zip. Bump the version instead of replacing it." }
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($zip + '.sha256'), ($hash + '  ' + [IO.Path]::GetFileName($zip) + "`n"), [Text.UTF8Encoding]::new($false))
$null = Expand-VerifiedPackage $zip (Join-Path $stage 'verified') $build.version $Runtime
Write-Host "Release v$($build.version) ready: $out"
Write-Host 'Upload ZIP and .sha256 to a published GitHub Release with the matching vX.Y.Z tag. Nothing was published by this script.'
