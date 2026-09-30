$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'console.ps1')
$installRoot = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier'
Write-Host "Helper installed: $(Test-Path -LiteralPath (Join-Path $installRoot 'bin/AgentTerminalNotifier.exe'))"
Write-Host "Protocol registered: $(Test-Path -LiteralPath 'HKCU:/Software/Classes/agent-terminal-notifier/shell/open/command')"
if (Get-Command code.cmd -ErrorAction SilentlyContinue) {
    $extensions = & code.cmd --list-extensions
    Write-Host "Extension installed: $($extensions -contains 'local-tools.agent-terminal-notifier')"
}
foreach ($tool in @('codex','claude','grok','gemini','copilot')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Host "CLI ${tool}: $($cmd.Source)"
        & $tool --version 2>&1 | Select-Object -First 1 | Out-Host
    } else { Write-Host "CLI ${tool}: not installed" }
}
$routes = Join-Path $installRoot 'routes'
if (Test-Path -LiteralPath $routes) {
    foreach ($file in Get-ChildItem -LiteralPath $routes -Filter '*.json') {
        try {
            $route = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            # Deliberately omit the per-window capability token and endpoint.
            Write-Host "Registration: $($route.terminals.Count) terminal(s)"
            foreach ($terminal in $route.terminals) { Write-Host "  shell PID $($terminal.pid)" }
        } catch { Write-Host 'Unreadable registration (window may have just closed).' }
    }
}
Write-Host 'In each VSCode window run Agent Notifier: Show Registered Terminals; window captured should be True.'
