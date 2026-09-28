import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { Deduplicator, Message, validMessage } from './core';

export async function activate(context: vscode.ExtensionContext) {
  if (process.platform !== 'win32' || vscode.env.remoteName) return;
  const output = vscode.window.createOutputChannel('Agent Terminal Notifier');
  context.subscriptions.push(output);
  const root = path.join(process.env.LOCALAPPDATA!, 'AgentTerminalNotifier');
  const helper = path.join(root, 'bin', 'AgentTerminalNotifier.exe');
  if (!fs.existsSync(helper)) {
    output.appendLine('Helper missing. Run Windows/scripts/pipeline.ps1 -Install.');
    return;
  }
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const pipe = 'agent-notifier-' + id;
  const routes = path.join(root, 'routes');
  fs.mkdirSync(routes, { recursive: true });
  const routeFile = path.join(routes, id + '.json');
  const terminals = new Map<string, { terminal: vscode.Terminal; pid: number }>();
  const dedupe = new Deduplicator();
  let hwnd = '0';
  let hwndPid = 0;
  let disposed = false;
  let capturePending = false;

  function save() {
    if (disposed) return;
    const temp = routeFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ pipe, token, terminals: [...terminals].map(([sessionId, t]) => ({ sessionId, pid: t.pid })) }));
    fs.renameSync(temp, routeFile);
  }
  function captureWindow() {
    if (!vscode.window.state.focused || capturePending || disposed) return;
    capturePending = true;
    execFile(helper, ['window', String(process.pid)], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      capturePending = false;
      if (error || disposed) return;
      try {
        const value = JSON.parse(stdout);
        if (value.hwnd !== '0') { hwnd = value.hwnd; hwndPid = value.pid; }
      } catch { output.appendLine('Could not capture VSCode window handle.'); }
    });
  }
  async function track(terminal: vscode.Terminal) {
    const pid = await terminal.processId;
    if (!pid || disposed || !vscode.window.terminals.includes(terminal)) return;
    if ([...terminals.values()].some(t => t.terminal === terminal)) return;
    terminals.set(randomUUID(), { terminal, pid });
    save();
  }
  function handle(m: Message) {
    const entry = terminals.get(m.sessionId);
    if (!entry || !vscode.window.terminals.includes(entry.terminal)) return { ok: false, reason: 'Terminal closed' };
    if (m.action === 'focus') {
      entry.terminal.show(false);
      return { ok: true, hwnd, hwndPid };
    }
    if (!dedupe.accept(m)) return { ok: true, duplicate: true };
    const config = vscode.workspace.getConfiguration('agentNotifier');
    const title = `${path.basename(m.cwd || '') || vscode.workspace.name || 'Terminal'} · ${m.source}`;
    const payload = { ...m, pipe, title, hwnd, hwndPid,
      sound: config.get<boolean>('sound', true),
      flash: config.get<boolean>('flash', true) && !vscode.window.state.focused,
      soundDirectory: config.get<string>('soundDirectory', '') || path.join(root, 'sounds') };
    const child = spawn(helper, ['show'], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('error', error => output.appendLine('Notifier failed: ' + error.message));
    child.stderr.on('data', data => output.appendLine(String(data)));
    child.on('exit', code => { if (code) output.appendLine('Notifier exited: ' + code); });
    output.appendLine(`${m.event}: ${title} → ${entry.terminal.name}`);
    return { ok: true };
  }
  const server = net.createServer(socket => {
    let input = '';
    let processed = false;
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', data => {
      if (processed) return;
      input += data;
      if (input.length > 16384) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end < 0) return;
      processed = true;
      try {
        const m: unknown = JSON.parse(input.slice(0, end));
        socket.end(JSON.stringify(validMessage(m, token) ? handle(m) : { ok: false, reason: 'Invalid request' }) + '\n');
      } catch { socket.end('{"ok":false,"reason":"Invalid JSON"}\n'); }
    });
  });
  server.on('error', error => output.appendLine('IPC failed: ' + error.message));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen('\\\\.\\pipe\\' + pipe, () => { server.removeListener('error', reject); resolve(); });
  });
  context.subscriptions.push({ dispose() {
    disposed = true; server.close();
    fs.rmSync(routeFile, { force: true });
    fs.rmSync(routeFile + '.tmp', { force: true });
  } });
  save();
  captureWindow();
  // A restored/reloaded terminal keeps its shell PID: no injected env vars needed.
  await Promise.all(vscode.window.terminals.map(track));
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(t => { void track(t); }),
    vscode.window.onDidCloseTerminal(t => {
      for (const [key, value] of terminals) if (value.terminal === t) terminals.delete(key);
      save();
    }),
    vscode.window.onDidChangeWindowState(() => captureWindow()),
    vscode.commands.registerCommand('agentNotifier.status', () => {
      output.appendLine(`${terminals.size} terminal(s), window captured: ${hwnd !== '0'}`);
      for (const t of terminals.values()) output.appendLine(`${t.terminal.name} · shell PID ${t.pid}`);
      output.show(true);
    }),
    vscode.commands.registerCommand('agentNotifier.test', async () => {
      captureWindow();
      const terminal = vscode.window.activeTerminal;
      if (!terminal) { void vscode.window.showWarningMessage('Open a terminal first.'); return; }
      await track(terminal);
      const entry = [...terminals].find(([, t]) => t.terminal === terminal);
      if (entry) handle({ token, action: 'notify', sessionId: entry[0], source: 'test', event: 'completed', eventId: randomUUID(), cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
    })
  );
}
