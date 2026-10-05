import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStartupFailure, readStartupConfig } from '../src/config/startup.js';

const env = {
  PORT: '10000',
  SESSION_SECRET: 'test-only-session-secret-with-more-than-32-bytes',
  MONGODB_READ_URI: 'mongodb+srv://read_23IT150:private-password@cluster.example.com/DB_23IT150',
  MONGODB_WRITE_URI: 'mongodb+srv://write_23IT150:private-password@cluster.example.com/DB_23IT150',
};

function failure(input) {
  try { readStartupConfig(input); }
  catch (error) { return error; }
  assert.fail('Cấu hình phải bị từ chối.');
}

test('đọc PORT Render và cấu hình hai kết nối mà không kết nối mạng', () => {
  const config = readStartupConfig(env);
  assert.equal(config.port, 10000);
  assert.equal(config.sessionConfig.secret, env.SESSION_SECRET);
  assert.equal(config.databaseConfig.databaseName, 'DB_23IT150');
  assert.equal(readStartupConfig({ ...env, PORT: undefined }).port, 3000);
});

test('lỗi PORT có bước cụ thể và không in giá trị đã nhập', () => {
  for (const port of ['0', '65536', '1.5', 'private-value']) {
    const error = failure({ ...env, PORT: port });
    assert.equal(error.startupStage, 'PORT');
    const log = formatStartupFailure('CONFIG', error);
    assert.match(log, /\[PORT\]/);
    assert.doesNotMatch(log, /private-value|private-password|mongodb\+srv:\/\//);
  }
});

test('Render thiếu hoặc có secret quá ngắn báo SESSION_CONFIG trước khi kết nối Atlas', () => {
  for (const secret of [undefined, '', 'private-short-secret']) {
    const error = failure({ ...env, SESSION_SECRET: secret });
    assert.equal(error.startupStage, 'SESSION_CONFIG');
    assert.match(formatStartupFailure('CONFIG', error), /\[SESSION_CONFIG\].*SESSION_SECRET/);
    assert.doesNotMatch(formatStartupFailure('CONFIG', error), /private-short-secret|private-password/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
  }
});

test('URI thiếu, thiếu đường dẫn database và sai username có log cụ thể đã làm sạch', () => {
  const cases = [
    [{ ...env, MONGODB_READ_URI: undefined }, /Thiếu biến môi trường MONGODB_READ_URI/],
    [{ ...env, MONGODB_WRITE_URI: '' }, /Thiếu biến môi trường MONGODB_WRITE_URI/],
    [{ ...env, MONGODB_READ_URI: env.MONGODB_READ_URI.replace('DB_23IT150', '') }, /MONGODB_READ_URI.*DB_23IT150.*đường dẫn/],
    [{ ...env, MONGODB_WRITE_URI: env.MONGODB_WRITE_URI.replace('write_23IT150', 'private-wrong-user') }, /MONGODB_WRITE_URI.*write_23IT150/],
    [{ ...env, MONGODB_READ_URI: 'private-invalid-uri' }, /MONGODB_READ_URI.*hợp lệ/],
  ];
  for (const [input, expected] of cases) {
    const error = failure(input);
    const log = formatStartupFailure('CONFIG', error);
    assert.match(log, /\[DATABASE_CONFIG\]/);
    assert.match(log, expected);
    assert.doesNotMatch(log, /private-password|private-wrong-user|private-invalid-uri|cluster\.example\.com|mongodb\+srv:\/\//);
  }
});

test('log Atlas phân biệt hai role và chỉ dùng category cố định', () => {
  const log = formatStartupFailure('ATLAS_CONNECT', {
    message: 'mongodb://private-user:private-password@private-host',
    connectionFailures: [
      { role: 'reader', category: 'AUTHENTICATION' },
      { role: 'writer', category: 'TLS_ALERT' },
    ],
  });
  assert.match(log, /reader: xác thực thất bại/);
  assert.match(log, /writer: TLS handshake.*outbound CIDR Render/);
  assert.doesNotMatch(log, /private-user|private-password|private-host|mongodb:\/\//);
});

test('lỗi không nhận diện, stage và category tùy ý không lộ nội dung driver', () => {
  const secret = 'mongodb://private-user:private-password@private-host';
  for (const stage of ['APP_SETUP', 'ATLAS_CONNECT', secret]) {
    const log = formatStartupFailure(stage, {
      startupStage: secret, message: secret,
      connectionFailures: [{ role: secret, category: secret }, { role: 'reader', category: '__proto__' }],
    });
    assert.doesNotMatch(log, /private-user|private-password|private-host|mongodb:\/\/|\[object Object\]/);
  }
});
