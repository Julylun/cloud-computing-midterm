import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionConfig, SESSION_TTL_MS } from '../src/config/session.js';

test('yêu cầu secret đủ dài và không có secret mặc định', () => {
  for (const secret of [undefined, '', ' '.repeat(64), 'short']) {
    assert.throws(() => readSessionConfig({ SESSION_SECRET: secret }), /SESSION_SECRET/);
  }
  const secret = 'a'.repeat(64);
  assert.equal(readSessionConfig({ SESSION_SECRET: secret }).secret, secret);
  assert.equal(SESSION_TTL_MS, 86400000);
});
