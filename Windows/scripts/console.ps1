# Match native UTF-8 output decoding and PowerShell-to-native pipe encoding.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Get-HookStatus([string]$ConfigScript) {
    $items = New-Object System.Collections.Generic.List[object]
    try {
        if ($ConfigScript -and (Test-Path -LiteralPath $ConfigScript) -and (Get-Command node -ErrorAction SilentlyContinue)) {
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $json = & node $ConfigScript status
            $code = $LASTEXITCODE
            $ErrorActionPreference = $previous
            if ($code -eq 0 -and $json) {
                $parsed = $json | ConvertFrom-Json
                foreach ($item in $parsed) { $items.Add($item) }
            }
        }
    } catch { }
    return ,$items.ToArray()
}

function Write-StateLine([string]$Label, [string]$State, [string]$Detail) {
    $color = switch ($State) {
        'changed' { 'Green' }
        'unchanged' { 'Yellow' }
        'missing' { 'Red' }
        default { 'DarkGray' }
    }
    Write-Host ('  {0,-14} {1,-12} {2}' -f $Label, $State, $Detail) -ForegroundColor $color
}

function Show-ApplySummary {
    param(
        [string]$Title,
        [ValidateSet('changed','unchanged')][string]$Outcome,
        [string]$Commit,
        [string]$Version,
        [string]$Runtime,
        [string]$Repository,
        [string[]]$ChangedAgents = @(),
        [string]$ConfigScript,
        [string]$PreviousCommit = '',
        [string]$PreviousVersion = '',
        [string]$Backup
    )
    $labels = @{ codex = 'Codex'; claude = 'Claude Code'; grok = 'Grok'; gemini = 'Gemini CLI'; copilot = 'Copilot CLI' }
    $titleColor = if ($Outcome -eq 'changed') { 'Green' } else { 'Yellow' }
    Write-Host $Title -ForegroundColor $titleColor
    if ($Repository) { Write-Host "  Repository     $Repository" -ForegroundColor Gray }
    $commitState = if ($Outcome -eq 'changed' -and $PreviousCommit -ne $Commit) { 'changed' } else { 'unchanged' }
    $versionState = if ($Outcome -eq 'changed' -and $PreviousVersion -ne $Version) { 'changed' } else { 'unchanged' }
    Write-StateLine 'Commit' $commitState $(if ($Commit) { $Commit } else { 'unknown' })
    Write-StateLine 'Version' $versionState ($(if ($Version) { $Version } else { 'unknown' }) + $(if ($Runtime) { " ($Runtime)" } else { '' }))
    $rows = Get-HookStatus $ConfigScript
    if ($rows.Count -eq 0) {
        $rows = foreach ($name in @('codex','claude','grok','gemini','copilot')) {
            [pscustomobject]@{ name = $name; cli = $false; hooked = $false; unknown = $true }
        }
    }
    $restart = @()
    foreach ($row in $rows) {
        $label = $labels[[string]$row.name]
        if (-not $label) { continue }
        if ($row.unknown -eq $true) { Write-StateLine $label 'unchanged' 'status not checked'; continue }
        if (-not $row.cli) { Write-StateLine $label 'skipped' 'CLI not installed'; continue }
        $restart += $label
        $rewritten = $Outcome -eq 'changed' -and ($ChangedAgents -contains $row.name)
        if ($rewritten) { Write-StateLine $label 'changed' 'hooks rewritten' }
        elseif ($row.hooked) { Write-StateLine $label 'unchanged' 'hook connected' }
        else { Write-StateLine $label 'missing' 'CLI found, hook not connected' }
    }
    if ($Backup) { Write-Host "  Backup         $Backup" -ForegroundColor Gray }
    if ($Outcome -eq 'unchanged') { Write-Host 'No files were written. Reload is not required.' -ForegroundColor Yellow }
    elseif ($restart) { Write-Host ('Reload VS Code and restart sessions: ' + ($restart -join ', ') + '.') -ForegroundColor Green }
    else { Write-Host 'Reload VS Code.' -ForegroundColor Green }
}
