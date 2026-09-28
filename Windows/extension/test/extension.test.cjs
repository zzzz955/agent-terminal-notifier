const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const Module = require('node:module');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');

test('extension IPC authenticates, selects the exact terminal, and rejects closed sessions', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-extension-test-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  const bin = path.join(root, 'AgentTerminalNotifier', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'AgentTerminalNotifier.exe'), '');
  const focused = [];
  const alerts = [];
  const terminal = (name, pid) => ({ name, processId: Promise.resolve(pid), show: preserve => focused.push([name, preserve]) });
  const a = terminal('Claude A', 1234);
  const b = terminal('Claude B', 5678);
  const handlers = {};
  const commands = {};
  const subscriptions = [];
  const disposable = { dispose() {} };
  const vscode = {
    env: {},
    workspace: { name: 'project', getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: {
      terminals: [a, b], state: { focused: true }, activeTerminal: a,
      createOutputChannel: () => ({ ...disposable, appendLine() {}, show() {} }),
      onDidOpenTerminal: cb => { handlers.open = cb; return disposable; },
      onDidCloseTerminal: cb => { handlers.close = cb; return disposable; },
      onDidChangeWindowState: cb => { handlers.window = cb; return disposable; },
      showWarningMessage() {}
    },
    commands: { registerCommand: (name, cb) => { commands[name] = cb; return disposable; } }
  };
  const originalLoad = Module._load;
  const originalExec = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
  childProcess.execFile = (_exe, _args, _opts, callback) => { callback(null, '{"hwnd":"123","pid":42}'); return new EventEmitter(); };
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) { alerts.push(JSON.parse(chunk.toString())); callback(); } });
    return child;
  };
  async function call(route, message) {
    return new Promise((resolve, reject) => {
      const socket = net.connect('\\\\.\\pipe\\' + route.pipe);
      socket.setEncoding('utf8');
      let output = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
      socket.on('data', chunk => { output += chunk; });
      socket.on('end', () => resolve(JSON.parse(output)));
    });
  }
  try {
    await require('../out/extension').activate({ subscriptions });
    const directory = path.join(root, 'AgentTerminalNotifier', 'routes');
    const file = path.join(directory, fs.readdirSync(directory).find(f => f.endsWith('.json')));
    const route = JSON.parse(fs.readFileSync(file));
    assert.equal(route.terminals.length, 2);
    const aId = route.terminals.find(t => t.pid === 1234).sessionId;
    const bId = route.terminals.find(t => t.pid === 5678).sessionId;
    const focus = { token: route.token, action: 'focus', sessionId: bId };
    assert.equal((await call(route, { ...focus, token: 'wrong' })).ok, false);
    assert.deepEqual(focused, []);
    assert.deepEqual(await call(route, focus), { ok: true, hwnd: '123', hwndPid: 42 });
    assert.deepEqual(focused, [['Claude B', false]]);
    const notify = { token: route.token, action: 'notify', sessionId: aId, source: 'claude', event: 'attention', cwd: 'C:\\한글 프로젝트' };
    assert.equal((await call(route, notify)).ok, true);
    assert.equal(alerts[0].title, '한글 프로젝트 · claude');
    assert.equal(alerts[0].sessionId, aId);
    assert.equal(alerts[0].flash, false);
    assert.equal((await call(route, notify)).duplicate, true);
    assert.equal(alerts.length, 1);
    vscode.window.terminals = [a];
    handlers.close(b);
    assert.equal((await call(route, focus)).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(file)).terminals.length, 1);
    assert.equal(focused.length, 1);
  } finally {
    for (const subscription of subscriptions.reverse()) subscription.dispose();
    Module._load = originalLoad;
    childProcess.execFile = originalExec;
    childProcess.spawn = originalSpawn;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
