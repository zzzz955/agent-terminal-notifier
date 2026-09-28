// Maintainer-only rebuild from committed ElevenLabs MP3 sources; no API/key needed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { analyzeWav } = require('./verify-sounds.cjs');
const root = path.resolve(__dirname, '../assets/sfx');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const sound of manifest.sounds) {
  const output = path.join(root, sound.file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(root, sound.source),
    '-af', manifest.optimization.filter, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', output];
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  const bytes = fs.readFileSync(output);
  const metrics = analyzeWav(bytes);
  if (!Number.isFinite(metrics.rmsDb)) throw new Error('Generated SFX is silent: ' + sound.event);
  // Short transients can fall below LUFS gating; finish with bounded PCM gain.
  const gain = Math.min(10 ** ((manifest.optimization.targetRmsDb - metrics.rmsDb) / 20),
    10 ** ((manifest.optimization.truePeakDb - metrics.peakDb) / 20));
  for (let offset = metrics.dataOffset; offset < metrics.dataOffset + metrics.dataLength; offset += 2)
    bytes.writeInt16LE(Math.round(bytes.readInt16LE(offset) * gain), offset);
  fs.writeFileSync(output, bytes);
  sound.sha256 = createHash('sha256').update(bytes).digest('hex');
  const final = analyzeWav(bytes);
  sound.metrics = { duration: final.duration, rmsDb: final.rmsDb, peakDb: final.peakDb };
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Four ElevenLabs SFX optimized to mono 44.1kHz PCM WAV.');
