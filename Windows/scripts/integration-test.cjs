// Real .NET executable -> process ancestry -> Node named pipe. No toast/registry edits.
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { additions } = require('./config.cjs');
const { validMessage } = require('../extension/out/core');

async function main() {
  const exe = path.resolve(process.argv[2]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notifier-test-'));
  const routes = path.join(root, 'AgentTerminalNotifier', 'routes');
  fs.mkdirSync(routes, { recursive: true });
  const pipe = 'agent-notifier-' + randomUUID();
  const token = 'b'.repeat(64);
  const sessionId = randomUUID();
  const received = [];
  const server = net.createServer(socket => {
    let data = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      const message = JSON.parse(data.split('\n')[0]);
      if (!validMessage(message, token)) { socket.end('{"ok":false}\n'); return; }
      received.push(message);
      socket.end('{"ok":true}\n');
    });
  });
  await new Promise(resolve => server.listen('\\\\.\\pipe\\' + pipe, resolve));
  fs.writeFileSync(path.join(routes, 'route.json'), JSON.stringify({ pipe, token, terminals: [{ sessionId, pid: process.pid }] }));
  // A stale endpoint that matches the same parent must not prevent fallback to a live endpoint.
  fs.writeFileSync(path.join(routes, 'stale.json'), JSON.stringify({ pipe: 'agent-notifier-' + randomUUID(), token, terminals: [{ sessionId: randomUUID(), pid: process.pid }] }));
  function run(command, args, input = '') {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, env: { ...process.env, LOCALAPPDATA: root } });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.stdout.resume();
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('exit', code => resolve({ code, stderr }));
      child.stdin.end(input);
    });
  }
  try {
    const payload = JSON.stringify({ cwd: 'C:\\한글 프로젝트', 'turn-id': 'turn-42' });
    assert.equal((await run(exe, ['send', 'codex', 'completed', payload, '--strict'])).code, 0);
    assert.equal(received[0].sessionId, sessionId);
    assert.equal(received[0].cwd, 'C:\\한글 프로젝트');
    assert.equal(received[0].eventId, 'turn-42');
    const command = additions(exe, 'codex').PermissionRequest[0].hooks[0].command;
    const encoded = command.split(' ').at(-1);
    assert.equal((await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], payload)).code, 0);
    assert.equal(received.length, 2, 'Codex PowerShell hook must finish IPC before exiting');
    assert.equal(received[1].event, 'attention');
    assert.equal(received[1].cwd, 'C:\\한글 프로젝트');
    assert.equal((await run(exe, ['send', 'claude', 'auto', '--strict'], JSON.stringify({ hook_event_name: 'StopFailure' }))).code, 0);
    assert.equal(received[2].event, 'error');
    const before = received.length;
    assert.equal((await run(exe, ['send', 'claude', 'auto', '--strict'], JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }))).code, 0);
    assert.equal(received.length, before);
    assert.equal((await run(exe, ['send', 'hook', 'blocked', '--strict'], '{}')).code, 0);
    assert.equal(received.at(-1).event, 'blocked');
    const originalFile = path.join(root, 'original-notify.cjs');
    const originalOutput = path.join(root, 'original-output.json');
    fs.writeFileSync(originalFile, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));');
    const original = [process.execPath, originalFile, originalOutput, 'space & "quote"', ''];
    assert.equal((await run(exe, ['fanout', JSON.stringify(original), payload, '--strict'])).code, 0);
    // The original notification runs independently; wait for its own output before asserting.
    for (let attempt = 0; attempt < 50 && !fs.existsSync(originalOutput); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(fs.readFileSync(originalOutput)), ['space & "quote"', '', payload]);
    assert.equal(received.at(-1).event, 'completed');
    fs.rmSync(path.join(routes, 'route.json'));
    fs.rmSync(path.join(routes, 'stale.json'));
    assert.equal((await run(exe, ['send', 'hook', 'blocked'], '{}')).code, 0);
    assert.equal((await run(exe, ['send', 'hook', 'blocked', '--strict'], '{}')).code, 1);
    console.log('Windows IPC integration passed: ancestry, Unicode, Codex shell hook, Claude error, idle filter, blocked, existing notify fanout, fail-open.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
