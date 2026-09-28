param([Parameter(Mandatory=$true)][string]$Directory, [switch]$ForceDefaults)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
$assets = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/sfx'
$manifest = Get-Content -LiteralPath (Join-Path $assets 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$stateFile = Join-Path $Directory '.defaults.json'
$previous = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Encoding UTF8 -Raw | ConvertFrom-Json } else { $null }
$hashes = @{}
$backup = Join-Path $Directory ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
foreach ($sound in $manifest.sounds) {
    $name = $sound.event
    $source = Join-Path $assets $sound.file
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if ($sourceHash -ne $sound.sha256) { throw "Bundled SFX hash mismatch: $name" }
    $file = Join-Path $Directory ($name + '.wav')
    $hashes[$name] = $sound.sha256
    if (Test-Path -LiteralPath $file) {
        $currentHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($currentHash -eq $sourceHash) { continue }
        $previousHash = if ($previous) { $previous.hashes.$name } else { $null }
        if (-not $ForceDefaults -and $currentHash -ne $sound.legacySha256 -and $currentHash -ne $previousHash) {
            Write-Host "Preserved custom SFX: $name"
            continue
        }
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $file -Destination (Join-Path $backup ($name + '.wav'))
    }
    Copy-Item -LiteralPath $source -Destination $file -Force
    Write-Host "Applied ElevenLabs SFX: $name"
}
$state = @{ version = $manifest.version; hashes = $hashes } | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($stateFile), $state, [System.Text.UTF8Encoding]::new($false))
