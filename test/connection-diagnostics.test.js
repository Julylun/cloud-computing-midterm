import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError, MongoServerSelectionError } from 'mongodb';
import { connectionFailureCategory } from '../src/db/connection-diagnostics.js';

test('phân loại mã xác thực, quyền và Atlas bằng giá trị cố định', () => {
  assert.equal(connectionFailureCategory({ code: 18 }), 'AUTHENTICATION');
  assert.equal(connectionFailureCategory({ code: 13 }), 'AUTHORIZATION');
  assert.equal(connectionFailureCategory({ code: 8000 }), 'ATLAS_REJECTED');
});

test('lỗi xác thực hoặc quyền bên trong wrapper được ưu tiên hơn lỗi mạng', () => {
  for (const [code, expected] of [[18, 'AUTHENTICATION'], [13, 'AUTHORIZATION'], [8000, 'ATLAS_REJECTED']]) {
    const wrapped = new MongoServerSelectionError('private selection message', {
      error: new MongoNetworkError('private network message'),
      servers: new Map([
        ['private-host:27017', { error: { cause: { code } } }],
      ]),
    });
    assert.equal(connectionFailureCategory(wrapped), expected);
  }
  assert.equal(connectionFailureCategory({
    code: 8000,
    cause: { code: 13, cause: { code: 18 } },
  }), 'AUTHENTICATION');
});

test('phân biệt DNS với kết nối TCP bị từ chối', () => {
  for (const error of [
    { code: 'ENOTFOUND' },
    { code: 'EAI_AGAIN' },
    { code: 'ECONNREFUSED', syscall: 'querySrv' },
    { code: 'ECONNREFUSED', syscall: 'queryTxt' },
    { code: 'ECONNREFUSED', message: 'querySrv ECONNREFUSED private-host' },
    { code: 'ECONNREFUSED', message: 'queryTxt ECONNREFUSED private-host' },
  ]) {
    assert.equal(connectionFailureCategory(error), 'DNS');
  }
  assert.equal(connectionFailureCategory({ code: 'ECONNREFUSED', syscall: 'connect' }), 'NETWORK');
  assert.equal(connectionFailureCategory({ code: 'ECONNREFUSED', message: 'private querySrvSuffix' }), 'NETWORK');
});

test('tách TLS alert và lỗi certificate từ cause của driver', () => {
  const alert = new MongoNetworkError('private TLS message', {
    cause: { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' },
  });
  assert.equal(connectionFailureCategory(alert), 'TLS_ALERT');
  for (const code of [
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  ]) {
    assert.equal(connectionFailureCategory({ cause: { code } }), 'TLS_CERTIFICATE');
  }
});

test('nhận lỗi mạng của driver và các mã kết nối thường gặp', () => {
  for (const error of [
    new MongoNetworkError('private network message'),
    new MongoServerSelectionError('private selection message', {}),
    ...['ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE']
      .map((code) => ({ code })),
  ]) {
    assert.equal(connectionFailureCategory(error), 'NETWORK');
  }
});

test('không lấy category hay nội dung tùy ý từ thông báo chứa credentials', () => {
  const credentials = 'mongodb://read_23IT150:private-secret@private-host/DB_23IT150';
  for (const error of [
    null, undefined, 'AUTHENTICATION',
    { code: credentials, message: credentials },
    { message: 'AUTHENTICATION TLS_ALERT querySrv ' + credentials },
    { category: credentials, cause: { message: credentials } },
  ]) {
    const result = connectionFailureCategory(error);
    assert.equal(result, 'UNKNOWN');
    assert.doesNotMatch(result, /mongodb|private|read_23IT150/);
  }
});

test('chu trình nguyên nhân không lặp vô hạn và chỉ duyệt tối đa 32 lỗi', () => {
  const cycle = { code: 'ECONNRESET' };
  cycle.cause = cycle;
  cycle.reason = { error: cycle, servers: new Map([['private-host', { error: cycle }]]) };
  assert.equal(connectionFailureCategory(cycle), 'NETWORK');

  const root = {};
  let current = root;
  for (let index = 1; index < 32; index += 1) {
    current.cause = {};
    current = current.cause;
  }
  current.code = 13;
  current.cause = { code: 18 };
  assert.equal(connectionFailureCategory(root), 'AUTHORIZATION');
});
