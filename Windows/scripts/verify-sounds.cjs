const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function analyzeWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  let format, data, dataOffset;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= bytes.length, 'Truncated WAV chunk');
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    const id = bytes.toString('ascii', offset, offset + 4);
    if (id === 'fmt ') format = chunk;
    if (id === 'data') { data = chunk; dataOffset = offset + 8; }
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && format.length >= 16 && data && data.length > 0);
  assert.equal(format.readUInt16LE(0), 1, 'PCM required for SoundPlayer');
  assert.equal(format.readUInt16LE(2), 1, 'Mono required');
  assert.equal(format.readUInt16LE(14), 16, '16-bit required');
  const rate = format.readUInt32LE(4);
  assert.equal(data.length % 2, 0);
  let peak = 0, sum = 0, first = -1, last = -1;
  for (let index = 0; index < data.length / 2; index++) {
    const value = data.readInt16LE(index * 2) / 32768;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
    if (Math.abs(value) > 0.005) { if (first < 0) first = index; last = index; }
  }
  const count = data.length / 2;
  return { rate, dataOffset, dataLength: data.length, duration: count / rate, peakDb: 20 * Math.log10(peak), rmsDb: 10 * Math.log10(sum / count),
    leadingSilence: first < 0 ? count / rate : first / rate,
    trailingSilence: last < 0 ? count / rate : (count - 1 - last) / rate,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

function main(directory) {
  const hashes = new Set();
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/sfx/manifest.json'), 'utf8'));
  for (const sound of manifest.sounds) {
    const metrics = analyzeWav(fs.readFileSync(path.join(directory, sound.event + '.wav')));
    console.log(`${sound.event}: ${metrics.duration.toFixed(2)}s, RMS ${metrics.rmsDb.toFixed(1)}dBFS, peak ${metrics.peakDb.toFixed(1)}dBFS`);
    assert.equal(metrics.rate, 44100);
    assert.ok(metrics.duration >= 0.2 && metrics.duration <= 2, 'SFX must be short and non-empty');
    assert.ok(metrics.rmsDb >= -20 && metrics.rmsDb <= -8, 'SFX must have audible average level');
    assert.ok(metrics.peakDb <= -1, 'SFX must have clipping headroom');
    assert.ok(metrics.leadingSilence <= 0.1 && metrics.trailingSilence <= 0.15, 'Trim excessive silence');
    assert.equal(metrics.sha256, sound.sha256, 'Use the committed optimized SFX');
    hashes.add(metrics.sha256);
  }
  assert.equal(hashes.size, 4, 'Each event must have a distinct sound');
  console.log('SFX checks passed: PCM format, duration, audible RMS, peak headroom, silence and asset hashes.');
}
module.exports = { analyzeWav };
if (require.main === module) main(process.argv[2]);
