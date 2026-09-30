const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('smol-toml');
const { mergeHooks, mergeFlat, updateToml, additions, paths, installStatus, agentFor } = require('../../scripts/config.cjs');
const exe = 'C:\\Users\\한글 user\\AppData\\Local\\AgentTerminalNotifier\\bin\\AgentTerminalNotifier.exe';
test('hook install/remove is idempotent and preserves unrelated handlers and settings', () => {
  const original = { model: 'keep', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-quality-check' }] }] } };
  const added = additions(exe, 'claude');
  const installed = mergeHooks(original, added);
  assert.deepEqual(mergeHooks(installed, added), installed);
  assert.deepEqual(mergeHooks(installed, {}, true), original);
  assert.deepEqual(installed.hooks.Stop[1].hooks[0].args, ['send', 'claude', 'auto']);
});
test('encoded Windows hooks merge/remove safely with spaces, Unicode and quotes', () => {
  const hooks = additions(exe.replace('user', "O'Neil"), 'codex');
  const installed = mergeHooks({}, hooks);
  assert.deepEqual(mergeHooks(installed, hooks), installed);
  assert.deepEqual(mergeHooks(installed, {}, true), { hooks: {} });
  const cmd = hooks.PermissionRequest[0].hooks[0].command;
  assert.ok(Buffer.from(cmd.split(' ').at(-1), 'base64').toString('utf16le').includes("O''Neil"));
});
test('TOML retains comments, user values and table placement; repeat install is stable', () => {
  const original = '# user comment\nmodel = "my-model"\n[features]\n# keep me\nother = true\n';
  const installed = updateToml(original, exe);
  assert.equal(parse(installed).features.hooks, true);
  assert.ok(installed.includes('# keep me'));
  assert.deepEqual(parse(updateToml(installed, exe)), parse(installed));
  const removed = updateToml(installed, exe, true);
  assert.deepEqual(parse(removed), parse(original));
  assert.ok(removed.includes('# user comment'));
});
test('pre-existing hooks=true survives uninstall and disabled hooks fail preflight', () => {
  const original = '[features]\nhooks = true\n';
  assert.deepEqual(parse(updateToml(updateToml(original, exe), exe, true)), parse(original));
  assert.throws(() => updateToml('[features]\nhooks = false\n', exe), /disabled/);
});
test('existing multiline notify is chained without shell quoting and restored on removal', () => {
  const original = '# keep\nnotify = [\n  "existing.exe",\n  "argument with spaces & quotes\\\""\n]\n';
  const installed = updateToml(original, exe);
  const notify = parse(installed).notify;
  assert.equal(notify[1], 'fanout');
  assert.deepEqual(JSON.parse(notify[2]), parse(original).notify);
  assert.deepEqual(parse(updateToml(installed, exe)), parse(installed));
  assert.deepEqual(parse(updateToml(installed, exe, true)), parse(original + '[features]\n'));
});
test('unsupported inline features and unmanaged notifier are rejected', () => {
  assert.throws(() => updateToml('features = { other = true }\n', exe), /inline/);
  assert.throws(() => updateToml('notify = ["AgentTerminalNotifier.exe"]\n', exe), /Unmanaged/);
});
test('grok, gemini and copilot hooks install and remove without dropping user handlers', () => {
  const grok = additions(exe, 'grok');
  const installed = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } }, grok);
  assert.equal(installed.hooks.StopCancelled[0].matcher, 'user_interrupt');
  assert.deepEqual(mergeHooks(installed, grok), installed);
  assert.equal(mergeHooks(installed, grok, true).hooks.Stop[0].hooks[0].command, 'keep-me');
  const gemini = Buffer.from(additions(exe, 'gemini').Notification[0].hooks[0].command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(gemini, /send gemini auto/);
  assert.match(gemini, /\{\}/);
  assert.equal(additions(exe, 'gemini').AfterAgent[0].hooks[0].timeout, 5000);
  const copilot = additions(exe, 'copilot');
  const mixed = mergeFlat({ version: 1, hooks: { agentStop: [{ type: 'command', bash: 'user-hook' }] } }, copilot);
  assert.equal(mixed.hooks.agentStop[1].args[1], 'copilot');
  assert.deepEqual(mergeFlat(mixed, copilot, true).hooks.agentStop, [{ type: 'command', bash: 'user-hook' }]);
  assert.equal(mergeFlat(mixed, copilot, true).hooks.notification, undefined);
});
test('install status distinguishes a connected hook from a CLI that has none', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'));
  try {
    const env = {
      CODEX_HOME: path.join(home, 'codex'),
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      GROK_HOME: path.join(home, 'grok'),
      GEMINI_CLI_HOME: path.join(home, 'gemini'),
      COPILOT_HOME: path.join(home, 'copilot')
    };
    const located = paths(home, env);
    fs.mkdirSync(path.dirname(located.grok), { recursive: true });
    fs.writeFileSync(located.grok, JSON.stringify(mergeHooks({}, additions(exe, 'grok'))));
    fs.mkdirSync(path.dirname(located.copilot), { recursive: true });
    fs.writeFileSync(located.copilot, JSON.stringify(mergeFlat({}, additions(exe, 'copilot'))));
    const rows = Object.fromEntries(installStatus({ home, env, cli: new Set(['grok', 'claude', 'copilot']) }).map(row => [row.name, row]));
    assert.equal(rows.grok.hooked, true);
    assert.equal(rows.grok.cli, true);
    assert.equal(rows.claude.cli, true);
    assert.equal(rows.claude.hooked, false);
    assert.equal(rows.copilot.hooked, true);
    assert.equal(rows.gemini.cli, false);
    assert.equal(rows.gemini.hooked, false);
    assert.equal(agentFor(located.grok, home, env), 'grok');
    assert.equal(agentFor(located.copilot, home, env), 'copilot');
    assert.equal(agentFor(located.codex, home, env), 'codex');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
