# Add this call at the actual deny/block branch of your existing hook.
# Do not register this example as an unconditional blocking hook.
$notifier = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier/bin/AgentTerminalNotifier.exe'
if (Test-Path -LiteralPath $notifier) {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    # Pass only location metadata; the notifier never needs prompts or tool arguments.
    @{ cwd = (Get-Location).Path } | ConvertTo-Json -Compress | & $notifier send hook blocked | Out-Null
}
# Keep the original hook decision/exit code after the notification call.
# Example: [Console]::Error.WriteLine('Your existing block reason'); exit 2
