import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizationError } from '../src/db/errors.js';

test('nhận diện Unauthorized của MongoDB và Atlas sandbox', () => {
  assert.equal(isAuthorizationError({ code: 13 }), true);
  assert.equal(isAuthorizationError({ code: 8000, codeName: 'AtlasError', message: 'user is not allowed to do action [insert]' }), true);
});

test('không coi lỗi Atlas khác hoặc lỗi mạng là kiểm chứng phân quyền đạt', () => {
  for (const error of [null, { code: 8000, codeName: 'AtlasError', message: 'bad auth' }, { code: 8000, codeName: 'AtlasError', message: 'internal error' }, { code: 'ECONNREFUSED' }]) {
    assert.equal(isAuthorizationError(error), false);
  }
});
