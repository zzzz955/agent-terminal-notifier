const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validMessage, Deduplicator } = require('../out/core');
const token = 'a'.repeat(64);
const message = { token, action: 'notify', sessionId: 'one', source: 'codex', event: 'completed', eventId: 'turn1' };
test('accepts known events and focus requests; rejects unauthorized or malformed input', () => {
  assert.ok(validMessage(message, token));
  assert.ok(validMessage({ token, action: 'focus', sessionId: 'one' }, token));
  for (const bad of [null, {}, { ...message, token: 'other' }, { ...message, source: 'arbitrary' }, { ...message, event: 'execute' }, { ...message, cwd: 15 }, { ...message, sessionId: 'x'.repeat(101) }])
    assert.equal(validMessage(bad, token), false);
});
test('deduplicates a turn but keeps different terminals, sources and states independent', () => {
  const d = new Deduplicator();
  assert.ok(d.accept(message, 0));
  assert.equal(d.accept(message, 1), false);
  assert.ok(d.accept({ ...message, sessionId: 'two' }, 1));
  assert.ok(d.accept({ ...message, event: 'attention' }, 1));
  assert.ok(d.accept({ ...message, source: 'claude' }, 1));
  assert.ok(d.accept(message, 10001));
});
