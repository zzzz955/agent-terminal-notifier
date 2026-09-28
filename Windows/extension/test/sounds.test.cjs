const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { analyzeWav } = require('../../scripts/verify-sounds.cjs');
const assets = path.resolve(__dirname, '../../assets/sfx');
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('bundled ElevenLabs SFX are distinct, audible and unclipped', () => {
  const hashes = new Set();
  for (const sound of manifest.sounds) {
    const metrics = analyzeWav(fs.readFileSync(path.join(assets, sound.file)));
    assert.equal(metrics.rate, 44100);
    assert.ok(metrics.duration >= 0.2 && metrics.duration <= 2);
    assert.ok(metrics.rmsDb >= -20 && metrics.rmsDb <= -8);
    assert.ok(metrics.peakDb <= -1);
    assert.equal(metrics.sha256, sound.sha256);
    hashes.add(metrics.sha256);
  }
  assert.equal(hashes.size, 4);
});

test('SFX upgrades managed defaults while retaining and backing up user audio', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sfx-test-'));
  const script = path.resolve(__dirname, '../../scripts/sounds.ps1');
  const apply = () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Directory', root], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    const old = Buffer.from('previous managed default');
    const custom = Buffer.from('user customized sound');
    fs.writeFileSync(path.join(root, 'completed.wav'), old);
    fs.writeFileSync(path.join(root, 'attention.wav'), custom);
    fs.writeFileSync(path.join(root, '.defaults.json'), JSON.stringify({ hashes: { completed: hash(old) } }));
    apply();
    assert.equal(hash(fs.readFileSync(path.join(root, 'completed.wav'))), manifest.sounds.find(s => s.event === 'completed').sha256);
    assert.deepEqual(fs.readFileSync(path.join(root, 'attention.wav')), custom);
    const backups = path.join(root, 'backups');
    assert.deepEqual(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'completed.wav')), old);
    apply();
    assert.equal(fs.readdirSync(backups).length, 1, 'Repeat install must not create redundant backups');
    assert.deepEqual(fs.readFileSync(path.join(root, 'attention.wav')), custom);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
