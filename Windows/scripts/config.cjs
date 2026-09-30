// Pure transformations are exported so merge/remove behavior can be tested on fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parse } = require('../extension/node_modules/smol-toml');
const marker = 'agent-terminal-notifier managed';
const agents = ['codex', 'claude', 'grok', 'gemini', 'copilot'];

function isOurs(handler) {
  const direct = (file, args) => typeof file === 'string' && /AgentTerminalNotifier\.exe$/i.test(file) && args?.[0] === 'send' && agents.includes(args?.[1]);
  if (direct(handler?.command, handler?.args) || direct(handler?.exec, handler?.args)) return true;
  if (typeof handler?.command !== 'string') return false;
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(handler.command);
  const command = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : handler.command;
  return new RegExp(`AgentTerminalNotifier\\.exe["']?\\s+send\\s+(${agents.join('|')})\\s`).test(command);
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

function shellCommand(exe, source, event, ack = false) {
  const script = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); $inputJson = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8).ReadToEnd(); $inputJson | & '${exe.replaceAll("'", "''")}' send ${source} ${event} | Out-Null; ${ack ? "if ($LASTEXITCODE -eq 0) { '{}' }; " : ''}exit $LASTEXITCODE`;
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}
function shellHook(exe, source, event, timeout, ack = false) {
  return { type: 'command', command: shellCommand(exe, source, event, ack), timeout };
}
function additions(exe, source) {
  const group = (hook, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [hook] });
  if (source === 'claude') {
    const hook = event => ({ type: 'command', command: exe, args: ['send', 'claude', event], timeout: 5 });
    return { Stop: [group(hook('auto'))], StopFailure: [group(hook('auto'))], Notification: [group(hook('auto'), 'permission_prompt|elicitation_dialog|agent_needs_input|worker_permission_prompt')] };
  }
  if (source === 'codex') {
    const hook = (event, timeout = 5) => shellHook(exe, 'codex', event, timeout);
    return { PermissionRequest: [group(hook('attention'))], Interrupt: [{ hooks: [hook('blocked', 3)] }] };
  }
  if (source === 'grok') {
    const hook = event => shellHook(exe, 'grok', event, 5);
    return {
      Stop: [group(hook('auto'))], StopFailure: [group(hook('error'))],
      StopCancelled: [{ matcher: 'user_interrupt', hooks: [hook('blocked')] }],
      Notification: [group(hook('attention'), 'permission_prompt|elicitation_dialog|agent_needs_input|worker_permission_prompt')]
    };
  }
  if (source === 'gemini') {
    const hook = event => shellHook(exe, 'gemini', event, 5000, true);
    return { AfterAgent: [group(hook('completed'))], Notification: [group(hook('auto'))] };
  }
  if (source === 'copilot') {
    const hook = event => ({ type: 'command', exec: exe, args: ['send', 'copilot', event], timeoutSec: 5 });
    return { agentStop: [hook('completed')], errorOccurred: [hook('error')], notification: [{ ...hook('attention'), matcher: 'permission_prompt|elicitation_dialog' }] };
  }
  throw new Error('Unknown agent: ' + source);
}
function mergeFlat(original, additions, remove = false) {
  const result = structuredClone(original);
  if (remove && !result.hooks) return result;
  result.version ??= 1;
  result.hooks ??= {};
  for (const [event, handlers] of Object.entries(result.hooks)) {
    if (!Array.isArray(handlers)) continue;
    result.hooks[event] = handlers.filter(h => !isOurs(h));
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  if (!remove) {
    for (const [event, handlers] of Object.entries(additions)) result.hooks[event] = [...(result.hooks[event] || []), ...handlers];
  }
  return result;
}
function commandExists(name) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [name], { windowsHide: true, encoding: 'utf8' });
  return result.status === 0;
}
function fileHasOurs(file, flat) {
  if (!fs.existsSync(file)) return false;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch { return false; }
  const hooks = data.hooks || {};
  if (flat) return Object.values(hooks).some(list => Array.isArray(list) && list.some(isOurs));
  return Object.values(hooks).some(groups => Array.isArray(groups) && groups.some(group => Array.isArray(group?.hooks) && group.hooks.some(isOurs)));
}
function installStatus(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const cli = options.cli || detect();
  const located = paths(home, env);
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return agents.map(name => {
    const hooked = name === 'codex' ? read(located.codex).includes('# ' + marker) || fileHasOurs(located.codexHooks, false)
      : fileHasOurs(located[name], name === 'copilot');
    return { name, cli: cli.has(name), hooked };
  });
}
function agentFor(file, home = os.homedir(), env = process.env) {
  const located = paths(home, env);
  const target = path.resolve(file).toLowerCase();
  const same = candidate => path.resolve(candidate).toLowerCase() === target;
  if (same(located.codex) || same(located.codexHooks)) return 'codex';
  for (const name of ['claude', 'grok', 'gemini', 'copilot']) if (same(located[name])) return name;
  return '';
}
function detect() {
  return new Set(agents.filter(commandExists));
}
function paths(home = os.homedir(), env = process.env) {
  const grok = env.GROK_HOME || path.join(home, '.grok');
  const gemini = env.GEMINI_CLI_HOME || path.join(home, '.gemini');
  const copilot = env.COPILOT_HOME || path.join(home, '.copilot');
  return { codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    codexHooks: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    grok: path.join(grok, 'hooks', 'agent-terminal-notifier.json'),
    gemini: path.join(gemini, 'settings.json'),
    copilot: path.join(copilot, 'hooks', 'agent-terminal-notifier.json'),
    copilotConfig: path.join(copilot, 'config.json') };
}
function ownedFile(original, added, remove, flat = false) {
  const merged = flat ? mergeFlat(original, added, remove) : mergeHooks(original, added, remove);
  const extras = Object.keys(merged).filter(key => key !== 'hooks' && key !== 'version');
  if (remove && !Object.keys(merged.hooks || {}).length && !extras.length) return null;
  return JSON.stringify(merged, null, 2) + '\n';
}
function changes(exe, remove, env = process.env, home = os.homedir()) {
  const selected = remove ? agents : [...detect()];
  const p = paths(home, env);
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
  const json = file => JSON.parse(read(file) || '{}');
  const result = [];
  const consider = (file, produce) => {
    if (remove && !fs.existsSync(file)) return;
    const value = produce();
    if (value === null) { if (fs.existsSync(file)) result.push([file, null]); return; }
    if (read(file) !== value) result.push([file, value]);
  };
  if (selected.includes('codex')) {
    consider(p.codex, () => updateToml(read(p.codex), exe, remove));
    consider(p.codexHooks, () => JSON.stringify(mergeHooks(json(p.codexHooks), additions(exe, 'codex'), remove), null, 2) + '\n');
  }
  if (selected.includes('claude')) consider(p.claude, () => JSON.stringify(mergeHooks(json(p.claude), additions(exe, 'claude'), remove), null, 2) + '\n');
  if (selected.includes('grok')) consider(p.grok, () => ownedFile(json(p.grok), additions(exe, 'grok'), remove));
  if (selected.includes('gemini')) {
    consider(p.gemini, () => {
      const settings = json(p.gemini);
      if (!remove && settings.hooksConfig?.enabled === false) throw new Error('Gemini hooks are explicitly disabled. Enable hooksConfig.enabled, then rerun.');
      return JSON.stringify(mergeHooks(settings, additions(exe, 'gemini'), remove), null, 2) + '\n';
    });
  }
  if (selected.includes('copilot')) {
    consider(p.copilot, () => {
      if (!remove && fs.existsSync(p.copilotConfig) && /"disableAllHooks"\s*:\s*true/.test(fs.readFileSync(p.copilotConfig, 'utf8')))
        throw new Error('Copilot hooks are explicitly disabled. Turn off disableAllHooks, then rerun.');
      return ownedFile(json(p.copilot), additions(exe, 'copilot'), remove, true);
    });
  }
  return result;
}
function main() {
  const [mode, exe, backup] = process.argv.slice(2);
  if (!['check', 'install', 'remove', 'status'].includes(mode) || (mode !== 'status' && !exe)) throw new Error('Usage: config.cjs check|install|remove|status EXE [BACKUP_DIR]');
  if (mode === 'status') { console.log(JSON.stringify(installStatus())); return; }
  const pending = changes(exe, mode === 'remove');
  if (mode === 'check') { console.log('Hook configuration preflight passed.'); return; }
  if (!backup) throw new Error('A backup directory is required.');
  fs.mkdirSync(backup, { recursive: true });
  const journal = pending.map(([file], i) => ({ file, agent: agentFor(file), backup: path.join(backup, `${i}-${path.basename(file)}`), existed: fs.existsSync(file) }));
  for (const entry of journal) if (entry.existed) fs.copyFileSync(entry.file, entry.backup);
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(journal, null, 2));
  let written = 0;
  try {
    for (const [file, value] of pending) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (value === null) fs.rmSync(file, { force: true });
      else {
        fs.writeFileSync(file + '.ant-tmp', value);
        fs.renameSync(file + '.ant-tmp', file);
      }
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
module.exports = { mergeHooks, mergeFlat, updateToml, additions, paths, agents, installStatus, agentFor };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
