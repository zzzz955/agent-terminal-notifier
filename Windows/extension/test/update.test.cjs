const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

test('Windows updater rejects rollback/tampering/ZIP traversal and creates a restorable VSIX snapshot', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-update-test-'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const scripts = path.resolve(__dirname, '../../scripts');
  const fixture = path.join(root, 'package');
  const required = ['scripts/install.ps1','scripts/install-core.ps1','scripts/config.cjs','scripts/console.ps1','scripts/apply.ps1','scripts/update-core.ps1','scripts/sounds.ps1','extension/package.json','dist/build.json','dist/bin/AgentTerminalNotifier.exe','dist/agent-terminal-notifier.vsix'];
  const files = required.map(relative => {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const value = relative === 'extension/package.json' ? JSON.stringify({ version: '0.2.0' }) : relative === 'dist/build.json' ? JSON.stringify({ version: '0.2.0', runtime: 'win-x64' }) : 'fixture only - not executable';
    fs.writeFileSync(target, value);
    return { path: relative, sha256: createHash('sha256').update(value).digest('hex') };
  });
  fs.writeFileSync(path.join(fixture, 'bundle-manifest.json'), JSON.stringify({ schemaVersion: 1, version: '0.2.0', runtime: 'win-x64', files }));
  const previous = path.join(root, 'previous-extension');
  fs.mkdirSync(previous);
  fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: 'agent-terminal-notifier', publisher: 'local-tools', version: '0.1.0', displayName: 'Notifier', description: 'Previous version', engines: { vscode: '^1.95.0' } }));
  fs.writeFileSync(path.join(previous, 'extension.js'), 'previous extension code');
  const script = `
$ErrorActionPreference = 'Stop'
. ${quote(path.join(scripts, 'update-core.ps1'))}
. ${quote(path.join(scripts, 'install-core.ps1'))}
function Check($value, $label) { if (-not $value) { throw $label } }
function Reject([scriptblock]$action) { $rejected = $false; try { & $action | Out-Null } catch { $rejected = $true }; Check $rejected 'Expected rejection' }
Check ((Get-UpdateDecision '' 'v0.2.0' '' '') -eq 'install') 'first install'
Check ((Get-UpdateDecision '0.1.9' '0.2.0' '' '') -eq 'update') 'upgrade'
Check ((Get-UpdateDecision '0.2.0' '0.2.0' 'abc' 'abc') -eq 'current') 'no-op'
Check ((Get-UpdateDecision '0.10.0' '0.2.0' '' '') -eq 'keep-newer') 'numeric version compare'
Reject { Get-UpdateDecision '0.2.0' '0.2.0' 'abc' 'def' }
Reject { Get-StableVersion 'v0.2.0-beta.1' }
Reject { Get-StableVersion '01.2.3' }
$release = @{ tag_name = 'v0.2.0'; assets = @(@{name='agent-terminal-notifier-windows-win-x64.zip'; state='uploaded'; id=1; digest=('sha256:' + ('a' * 64))}) }
Check ((Get-ReleaseAsset $release 'win-x64').id -eq 1) 'release asset'
Check ($null -eq (Get-ReleaseAsset $release 'win-arm64')) 'missing architecture'
$duplicate = @{ tag_name = 'v0.2.0'; assets = @($release.assets[0], $release.assets[0]) }
Reject { Get-ReleaseAsset $duplicate 'win-x64' }
$release.prerelease = $true
Reject { Get-ReleaseAsset $release 'win-x64' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = ${quote(path.join(root, 'valid.zip'))}
[IO.Compression.ZipFile]::CreateFromDirectory(${quote(fixture)}, $zip)
$sha = (Get-FileHash -LiteralPath $zip).Hash
Assert-FileDigest $zip $sha
Reject { Assert-FileDigest $zip ('b' * 64) }
$null = Expand-VerifiedPackage $zip ${quote(path.join(root, 'valid-extracted'))} 'v0.2.0' 'win-x64'
Reject { Expand-VerifiedPackage $zip ${quote(path.join(root, 'wrong-version'))} 'v0.3.0' 'win-x64' }
Reject { Expand-VerifiedPackage $zip ${quote(path.join(root, 'wrong-arch'))} 'v0.2.0' 'win-arm64' }
[IO.File]::WriteAllText(${quote(path.join(fixture, 'scripts/install.ps1'))}, 'tampered')
$bad = ${quote(path.join(root, 'tampered.zip'))}
[IO.Compression.ZipFile]::CreateFromDirectory(${quote(fixture)}, $bad)
Reject { Expand-VerifiedPackage $bad ${quote(path.join(root, 'tampered-extracted'))} 'v0.2.0' 'win-x64' }
$escape = ${quote(path.join(root, 'escape.zip'))}
$archive = [IO.Compression.ZipFile]::Open($escape, [IO.Compression.ZipArchiveMode]::Create)
$null = $archive.CreateEntry('../outside.txt'); $archive.Dispose()
Reject { Expand-VerifiedPackage $escape ${quote(path.join(root, 'escape-extracted'))} '0.2.0' 'win-x64' }
Check (-not (Test-Path -LiteralPath ${quote(path.join(root, 'outside.txt'))})) 'no ZIP path escape'
function code.cmd { return ${quote(previous)} }
$snapshot = ${quote(path.join(root, 'previous.vsix'))}
Check (Save-InstalledVsix $snapshot) 'previous extension snapshot'
[IO.Compression.ZipFile]::ExtractToDirectory($snapshot, ${quote(path.join(root, 'snapshot'))})
$xml = [xml](Get-Content -LiteralPath ${quote(path.join(root, 'snapshot/extension.vsixmanifest'))} -Raw)
Check ($xml.SelectSingleNode('//*[local-name()="Identity"]').GetAttribute('Version') -eq '0.1.0') 'restorable VSIX version'
Check ((Get-Content -LiteralPath ${quote(path.join(root, 'snapshot/extension/extension.js'))} -Raw) -eq 'previous extension code') 'snapshot retains code'
Write-Output 'Updater checks passed.'
`;
  const file = path.join(root, 'test.ps1');
  fs.writeFileSync(file, script);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('Updater checks passed.'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repository sync follows the default branch and resets a dirty cache', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sync-test-'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const scripts = path.resolve(__dirname, '../../scripts');
  const origin = path.join(root, 'origin');
  const dest = path.join(root, 'cache');
  const blocked = path.join(root, 'not-a-repo');
  const script = `
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. ${quote(path.join(scripts, 'update-core.ps1'))}
function Check($value, $label) { if (-not $value) { throw $label } }
function Reject([scriptblock]$action) { $rejected = $false; try { & $action | Out-Null } catch { $rejected = $true }; Check $rejected 'Expected rejection' }
$origin = ${quote(origin)}
$dest = ${quote(dest)}
New-Item -ItemType Directory -Path $origin | Out-Null
& git -C $origin init -b main
if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
function Commit([string]$Message) {
    & git -C $origin -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false add marker.txt
    if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
    & git -C $origin -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
}
[IO.File]::WriteAllText((Join-Path $origin 'marker.txt'), ('one' + [char]10))
Commit 'first'
$first = (& git -C $origin rev-parse HEAD).Trim()
$head = Sync-RepositorySource 'fixture/notifier' $dest $origin
Check (@($head).Count -eq 1) 'one commit value'
Check ($head -match '^[0-9a-fA-F]{40}$') 'commit shape'
Check ($head -eq $first) 'first commit'
Check ((Get-Content -LiteralPath (Join-Path $dest 'marker.txt') -Raw).Trim() -eq 'one') 'first file'
[IO.File]::WriteAllText((Join-Path $dest 'marker.txt'), ('dirty' + [char]10))
[IO.File]::WriteAllText((Join-Path $origin 'marker.txt'), ('two' + [char]10))
Commit 'second'
$second = (& git -C $origin rev-parse HEAD).Trim()
$head = Sync-RepositorySource 'fixture/notifier' $dest $origin
Check (@($head).Count -eq 1) 'one updated commit'
Check ($head -eq $second) 'second commit'
Check ($head -ne $first) 'commit changed'
Check ((Get-Content -LiteralPath (Join-Path $dest 'marker.txt') -Raw).Trim() -eq 'two') 'cache reset'
Reject { Sync-RepositorySource 'fixture/notifier' $dest 'C:\no\such\remote' }
New-Item -ItemType Directory -Path ${quote(blocked)} | Out-Null
Reject { Sync-RepositorySource 'fixture/notifier' ${quote(blocked)} $origin }
Check (Test-Path -LiteralPath ${quote(blocked)}) 'non-git checkout kept'
Check (-not (Test-Path -LiteralPath ${quote(path.join(blocked, '.git'))})) 'non-git checkout not replaced'
Reject { Sync-RepositorySource 'not a repo' ${quote(path.join(root, 'unused'))} '' }
Write-Output 'Repository sync passed.'
`;
  const file = path.join(root, 'test.ps1');
  fs.writeFileSync(file, script);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('Repository sync passed.'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed Windows install restores existing helper, sounds, version and extension', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rollback-test-'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const windows = path.resolve(__dirname, '../..');
  const candidate = path.join(root, 'Windows');
  fs.cpSync(path.join(windows, 'scripts'), path.join(candidate, 'scripts'), { recursive: true });
  fs.cpSync(path.join(windows, 'assets'), path.join(candidate, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'extension/node_modules'), { recursive: true });
  fs.cpSync(path.join(windows, 'extension/node_modules/smol-toml'), path.join(candidate, 'extension/node_modules/smol-toml'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'dist/bin'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'dist/build.json'), JSON.stringify({ version: '0.2.0', runtime: 'win-x64' }));
  fs.writeFileSync(path.join(candidate, 'dist/agent-terminal-notifier.vsix'), 'candidate fixture');
  const install = path.join(root, 'local/AgentTerminalNotifier');
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(install, 'sounds'), { recursive: true });
  fs.writeFileSync(path.join(install, 'bin/previous.txt'), 'previous helper');
  fs.writeFileSync(path.join(install, 'sounds/custom.wav'), 'custom sound');
  const state = JSON.stringify({ version: '0.1.0', runtime: 'win-x64', repository: 'fixture/notifier' });
  fs.writeFileSync(path.join(install, 'installed.json'), state);
  fs.writeFileSync(path.join(install, 'extension.vsix'), 'previous archive');
  const previous = path.join(root, 'previous-extension');
  fs.mkdirSync(previous);
  fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: 'agent-terminal-notifier', publisher: 'local-tools', version: '0.1.0', displayName: 'Notifier', description: 'Previous', engines: { vscode: '^1.95.0' } }));
  const script = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${quote(path.join(root, 'local'))}
$env:CODEX_HOME = ${quote(path.join(root, 'codex'))}
$env:CLAUDE_CONFIG_DIR = ${quote(path.join(root, 'claude'))}
$env:GROK_HOME = ${quote(path.join(root, 'grok'))}
$env:GEMINI_CLI_HOME = ${quote(path.join(root, 'gemini'))}
$env:COPILOT_HOME = ${quote(path.join(root, 'copilot'))}
Add-Type -TypeDefinition 'public class FixtureHelper { public static int Main(string[] args) { return 0; } }' -OutputAssembly ${quote(path.join(candidate, 'dist/bin/AgentTerminalNotifier.exe'))} -OutputType ConsoleApplication
$global:fixtureAttempts = 0
function code.cmd {
    if ($args[0] -eq '--locate-extension') { return ${quote(previous)} }
    $global:fixtureAttempts++
    if ($global:fixtureAttempts -eq 1) { $global:LASTEXITCODE = 1 } else { $global:LASTEXITCODE = 0 }
}
$failed = $false
try { & ${quote(path.join(candidate, 'scripts/install.ps1'))} -Repository 'fixture/notifier' } catch { $failed = $true; $reason = $_.Exception.Message }
if (-not $failed -or $global:fixtureAttempts -ne 2) { throw "Expected failed install followed by extension rollback; attempts=$global:fixtureAttempts; reason=$reason" }
if ((Get-Content -LiteralPath ${quote(path.join(install, 'bin/previous.txt'))} -Raw) -ne 'previous helper') { throw 'Old helper not restored' }
if (Test-Path -LiteralPath ${quote(path.join(install, 'bin/AgentTerminalNotifier.exe'))}) { throw 'Candidate helper still installed' }
if (@(Get-ChildItem -LiteralPath ${quote(path.join(install, 'sounds'))} -File).Count -ne 1) { throw 'Sound rollback failed' }
if ((Get-Content -LiteralPath ${quote(path.join(install, 'installed.json'))} -Raw) -ne ${quote(state)}) { throw 'Installed version changed on failure' }
if ((Get-Content -LiteralPath ${quote(path.join(install, 'extension.vsix'))} -Raw) -ne 'previous archive') { throw 'VSIX archive changed on failure' }
Write-Output 'Rollback checks passed.'
`;
  const file = path.join(root, 'rollback.ps1');
  fs.writeFileSync(file, script);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('Rollback checks passed.'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
