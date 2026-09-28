const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const hashes = new Set();
for (const name of ['completed', 'attention', 'blocked', 'error']) {
  const bytes = fs.readFileSync(path.join(process.argv[2], name + '.wav'));
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  assert.equal(bytes.readUInt16LE(20), 1); // PCM
  assert.equal(bytes.readUInt16LE(22), 1); // mono
  assert.equal(bytes.readUInt32LE(24), 22050);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  assert.equal(bytes.readUInt32LE(40) + 44, bytes.length);
  assert.ok(bytes.length > 10000);
  hashes.add(require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
}
assert.equal(hashes.size, 4, 'Each event must have a distinct sound');
console.log('SFX checks passed: four distinct valid PCM WAV files.');
