const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('smol-toml');
const { mergeHooks, updateToml, additions } = require('../../scripts/config.cjs');
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
