// Pure transformations are exported so merge/remove behavior can be tested on fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('../extension/node_modules/smol-toml');
const marker = 'agent-terminal-notifier managed';

function isOurs(handler) {
  if (typeof handler?.command !== 'string') return false;
  if (/AgentTerminalNotifier\.exe$/i.test(handler.command) && ['codex', 'claude'].includes(handler.args?.[1]) && handler.args?.[0] === 'send') return true;
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(handler.command);
  const command = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : handler.command;
  return /AgentTerminalNotifier\.exe["']?\s+send\s+(codex|claude)\s/.test(command);
}
function mergeHooks(original, additions, remove = false) {
  const result = structuredClone(original);
  if (remove && !result.hooks) return result;
  result.hooks ??= {};
  for (const [event, groups] of Object.entries(result.hooks)) {
    result.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(h => !isOurs(h)) })).filter(group => group.hooks.length);
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  if (!remove) {
    for (const [event, groups] of Object.entries(additions)) result.hooks[event] = [...(result.hooks[event] || []), ...groups];
  }
  return result;
}

function updateToml(text, exe, remove = false) {
  const parsed = parse(text);
  const managed = text.includes('# ' + marker);
  if (remove && !managed) return text;
  const oldNotify = managed && parsed.notify?.[1] === 'fanout' ? JSON.parse(parsed.notify[2]) : managed ? undefined : parsed.notify;
  if (oldNotify !== undefined && (!Array.isArray(oldNotify) || !oldNotify.length || oldNotify.some(arg => typeof arg !== 'string')))
    throw new Error('Invalid Codex notify command.');
  if (oldNotify?.some(arg => arg.includes('AgentTerminalNotifier.exe')))
    throw new Error('Unmanaged notifier entry exists. Remove it manually before installing.');
  const lines = text.split(/\r?\n/);
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '# ' + marker) {
      i++; // Only remove entries created by this installer.
      continue;
    }
    output.push(lines[i]);
  }
  let cleaned = output.join('\n');
  if (!managed && oldNotify) {
    // Identify the complete top-level assignment, including multiline arrays.
    const rows = cleaned.split('\n');
    const start = rows.findIndex(row => /^\s*notify\s*=/.test(row));
    if (start < 0) throw new Error('Cannot locate Codex notify assignment.');
    let end = start;
    for (; end < rows.length; end++) {
      try { if (parse(rows.slice(start, end + 1).join('\n')).notify) break; } catch { }
    }
    if (end === rows.length) throw new Error('Cannot parse Codex notify assignment.');
    rows.splice(start, end - start + 1);
    cleaned = rows.join('\n');
  }
  if (remove && oldNotify) cleaned = 'notify = ' + JSON.stringify(oldNotify) + '\n' + cleaned;
  if (!remove) {
    // Never rewrite a user's TOML through a serializer: retain comments and layout.
    const after = parse(cleaned);
    if (after.notify) throw new Error('Unmanaged notifier entry exists. Remove it manually before installing.');
    const notifyArgs = oldNotify ? [exe, 'fanout', JSON.stringify(oldNotify)] : [exe, 'send', 'codex', 'completed'];
    const notify = '# ' + marker + '\nnotify = ' + JSON.stringify(notifyArgs);
    cleaned = notify + '\n' + cleaned;
    if (after.features?.hooks !== true) {
      if (after.features?.hooks === false || after.features?.codex_hooks !== undefined)
        throw new Error('Codex hooks are explicitly disabled or use a legacy alias. Enable features.hooks = true manually, then rerun.');
      const section = /^\[features\]\s*(?:#.*)?$/m.exec(cleaned);
      if (section) {
        const end = section.index + section[0].length;
        cleaned = cleaned.slice(0, end) + '\n# ' + marker + '\nhooks = true' + cleaned.slice(end);
      } else if (after.features !== undefined) {
        throw new Error('Unsupported inline/dotted features table. Add features.hooks = true manually, then rerun.');
      } else cleaned += '\n[features]\n# ' + marker + '\nhooks = true\n';
    }
  }
  parse(cleaned); // Reject a broken transform before touching a real file.
  return cleaned;
}

function additions(exe, source) {
  const handler = (event, timeout = 5) => {
    if (source === 'claude') return { type: 'command', command: exe, args: ['send', source, event], timeout };
    const script = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); $inputJson = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8).ReadToEnd(); $inputJson | & '${exe.replaceAll("'", "''")}' send codex ${event} | Out-Null; exit $LASTEXITCODE`;
    return { type: 'command', command: 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'), timeout };
  };
  const group = (event, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [handler(event)] });
  return source === 'codex'
    ? { PermissionRequest: [group('attention')], Interrupt: [{ hooks: [handler('blocked', 3)] }] }
    : { Stop: [group('auto')], StopFailure: [group('auto')], Notification: [group('auto', 'permission_prompt|elicitation_dialog|agent_needs_input|worker_permission_prompt')] };
}

function paths(home = os.homedir()) {
  return { codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    codexHooks: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
    claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json') };
}
function changes(exe, remove) {
  const p = paths();
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
  const json = file => JSON.parse(read(file) || '{}');
  const result = [
    [p.codex, updateToml(read(p.codex), exe, remove)],
    [p.codexHooks, JSON.stringify(mergeHooks(json(p.codexHooks), additions(exe, 'codex'), remove), null, 2) + '\n'],
    [p.claude, JSON.stringify(mergeHooks(json(p.claude), additions(exe, 'claude'), remove), null, 2) + '\n']
  ];
  return result.filter(([file, value]) => !(remove && !fs.existsSync(file)) && read(file) !== value);
}
function main() {
  const [mode, exe, backup] = process.argv.slice(2);
  if (!['check', 'install', 'remove'].includes(mode) || !exe) throw new Error('Usage: config.cjs check|install|remove EXE [BACKUP_DIR]');
  const pending = changes(exe, mode === 'remove');
  if (mode === 'check') { console.log('Hook configuration preflight passed.'); return; }
  if (!backup) throw new Error('A backup directory is required.');
  fs.mkdirSync(backup, { recursive: true });
  const journal = pending.map(([file], i) => ({ file, backup: path.join(backup, `${i}-${path.basename(file)}`), existed: fs.existsSync(file) }));
  for (const entry of journal) if (entry.existed) fs.copyFileSync(entry.file, entry.backup);
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(journal, null, 2));
  let written = 0;
  try {
    for (const [file, value] of pending) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.ant-tmp', value);
      fs.renameSync(file + '.ant-tmp', file);
      written++;
    }
  } catch (error) {
    for (const entry of journal.slice(0, written)) {
      if (entry.existed) fs.copyFileSync(entry.backup, entry.file);
      else fs.rmSync(entry.file, { force: true });
    }
    for (const [file] of pending) fs.rmSync(file + '.ant-tmp', { force: true });
    throw error;
  }
  console.log(`${mode}: ${pending.length} setting file(s) changed. Backup: ${backup}`);
}
module.exports = { mergeHooks, updateToml, additions, paths };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
