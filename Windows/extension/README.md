# Agent Terminal Notifier (Windows)

Links Codex CLI / Claude Code notifications to the exact local VSCode terminal.

Install the Windows helper and hooks through the repository's
`Windows/scripts/pipeline.ps1 -Install`, then reload VSCode and restart agents.
The VSIX alone does not install the helper or modify agent settings.

Commands:

- **Agent Notifier: Test Active Terminal**: emit a test notification for the selected terminal.
- **Agent Notifier: Show Registered Terminals**: inspect shell PIDs and window capture status.

Click a Windows notification to restore its original window and focus its terminal.
Works with ordinary local integrated terminals; WSL, SSH and containers are not supported.

Settings: `agentNotifier.sound`, `agentNotifier.flash`, `agentNotifier.soundDirectory`.
See the repository's `Windows/README.md` for setup, manual checks and uninstall steps.
