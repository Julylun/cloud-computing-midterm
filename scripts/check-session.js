import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase, readDatabaseConfig } from '../src/db/database.js';
import { isAuthorizationError } from '../src/db/errors.js';
import { readSessionConfig } from '../src/config/session.js';
import { MongoSessionStore } from '../src/session/mongo-store.js';

let stage = 'Đọc cấu hình Database và Session';
let database;
let verified = false;
let cleanupSucceeded = true;
let probesAttempted = false;
const sid = 'probe-' + randomUUID();
const deniedSid = 'probe-' + randomUUID();
const probeIds = [sid, deniedSid];
const verifyTtl = process.argv.includes('--verify-ttl');

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

async function denied(label, action) {
  stage = label;
  try {
    await action();
  } catch (error) {
    assert.ok(isAuthorizationError(error), label + ': phải bị từ chối vì thiếu quyền.');
    console.log('PASS: ' + label + ' bị từ chối.');
    return;
  }
  throw new Error(label + ': quyền đang rộng hơn yêu cầu.');
}

try {
  const { ttlMs } = readSessionConfig();
  database = createDatabase(readDatabaseConfig());
  stage = 'Kết nối hai tài khoản';
  await database.connect();
  stage = 'Health check';
  await database.health();
  const reader = database.readDb.collection('sessions');
  const writer = database.writeDb.collection('sessions');

  stage = 'Reader đọc sessions';
  await reader.findOne({ _id: sid });
  console.log('PASS: reader đọc được sessions.');

  probesAttempted = true;
  await denied('Reader insert sessions', () => reader.insertOne({
    _id: deniedSid,
    session: JSON.stringify({ probe: true }),
    expiresAt: new Date(Date.now() + ttlMs),
  }));
  await denied('Reader update sessions', () => reader.updateOne(
    { _id: deniedSid }, { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
  ));
  await denied('Reader remove sessions', () => reader.deleteOne({ _id: deniedSid }));
  await denied('Writer find sessions', () => writer.findOne({ _id: sid }));

  const storeOptions = { readDb: database.readDb, writeDb: database.writeDb, ttlMs };
  const store = new MongoSessionStore(storeOptions);
  const sample = {
    cookie: {
      originalMaxAge: ttlMs,
      expires: new Date(Date.now() + ttlMs),
      httpOnly: true,
      sameSite: 'lax',
    },
    lastBookCode: '150-PROBE-SESSION',
  };

  stage = 'Store set tạo session bằng writer và get bằng reader';
  await callStore(store, 'set', sid, sample);
  assert.equal((await callStore(store, 'get', sid))?.lastBookCode, sample.lastBookCode);
  console.log('PASS: writer upsert phiên mới, reader đọc lại nội dung.');

  stage = 'Store set cập nhật session bằng writer';
  const updatedSample = { ...sample, lastBookCode: '150-PROBE-SESSION-UPDATED' };
  await callStore(store, 'set', sid, updatedSample);
  assert.equal((await callStore(store, 'get', sid))?.lastBookCode, updatedSample.lastBookCode);
  const beforeTouch = await reader.findOne({ _id: sid });
  assert.ok(beforeTouch?.expiresAt instanceof Date, 'expiresAt phải là BSON Date.');
  assert.ok(beforeTouch.expiresAt.getTime() > Date.now(), 'Phiên kiểm chứng phải còn hạn.');
  console.log('PASS: writer cập nhật được phiên hiện có; expiresAt là BSON Date.');

  stage = 'Store touch gia hạn bằng writer';
  const extendedExpiry = new Date(beforeTouch.expiresAt.getTime() + 60_000);
  await callStore(store, 'touch', sid, {
    ...updatedSample, cookie: { ...sample.cookie, expires: extendedExpiry },
  });
  const afterTouch = await reader.findOne({ _id: sid });
  assert.ok(afterTouch?.expiresAt instanceof Date);
  assert.equal(afterTouch.expiresAt.getTime(), extendedExpiry.getTime());
  assert.equal((await callStore(store, 'get', sid))?.lastBookCode, updatedSample.lastBookCode);
  console.log('PASS: touch gia hạn phiên và giữ nội dung.');

  stage = 'Store get loại phiên hết hạn trước khi TTL xóa';
  const futureStore = new MongoSessionStore({
    ...storeOptions, now: () => afterTouch.expiresAt.getTime() + 1,
  });
  assert.equal(await callStore(futureStore, 'get', sid), null);
  assert.equal((await callStore(store, 'get', sid))?.lastBookCode, updatedSample.lastBookCode);
  console.log('PASS: Store không trả phiên hết hạn dù document còn trong Atlas.');

  stage = 'Store destroy xóa session bằng writer';
  await callStore(store, 'destroy', sid);
  assert.equal(await callStore(store, 'get', sid), null);
  assert.equal(await reader.findOne({ _id: sid }), null);
  console.log('PASS: writer xóa được phiên; reader không còn tìm thấy.');

  if (verifyTtl) {
    stage = 'TTL tự xóa phiên hết hạn trong tối đa 150 giây';
    const ttlSid = 'probe-' + randomUUID();
    probeIds.push(ttlSid);
    const expiresAt = new Date(Date.now() - 60_000);
    await writer.updateOne({ _id: ttlSid }, { $set: {
      session: JSON.stringify({ ...sample, cookie: { ...sample.cookie, expires: expiresAt } }),
      expiresAt,
    } }, { upsert: true });
    assert.ok(await reader.findOne({ _id: ttlSid }), 'Phiên kiểm chứng TTL phải được ghi và đọc lại trước khi chờ xóa.');
    console.log('WAIT: phiên PROBE hết hạn đã tồn tại; chờ Atlas TTL tự xóa (tối đa 150 giây).');
    const startedAt = Date.now();
    const deadline = startedAt + 150_000;
    let ttlDeleted = false;
    while (Date.now() <= deadline) {
      if (await reader.findOne({ _id: ttlSid }) === null) {
        ttlDeleted = true;
        break;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(3000, remainingMs));
    }
    assert.ok(ttlDeleted, 'Atlas chưa tự xóa phiên hết hạn trong thời hạn kiểm chứng.');
    console.log('PASS: Atlas TTL tự xóa phiên PROBE sau khoảng ' + Math.round((Date.now() - startedAt) / 1000) + ' giây.');
  }
  verified = true;
} catch {
  console.error('FAIL tại bước: ' + stage + '. Kiểm tra .env, Network Access, quyền riêng trên sessions và TTL index.');
  process.exitCode = 1;
} finally {
  if (database) {
    if (probesAttempted) {
      for (const probeId of probeIds) {
        try {
          // Only remove documents whose IDs were generated by this invocation.
          await database.writeDb.collection('sessions').deleteOne({ _id: probeId });
        } catch {
          cleanupSucceeded = false;
        }
      }
    }
    try {
      await database.close();
    } catch {
      cleanupSucceeded = false;
    }
  }
  if (!cleanupSucceeded) {
    console.error('FAIL: không thể dọn toàn bộ phiên PROBE hoặc đóng kết nối; kiểm tra quyền remove trên sessions.');
    process.exitCode = 1;
  }
}

if (verified && cleanupSucceeded) {
  console.log('Kiểm chứng Store và phân quyền Session đạt; các phiên PROBE đã được dọn.');
  if (verifyTtl) {
    console.log('Đã kiểm chứng hành vi TTL tự xóa trên Atlas; cấu hình index expiresAt / expireAfterSeconds: 0 xem trong Data Explorer.');
  } else {
    console.log('TTL chưa được kiểm tra tự động: dùng --verify-ttl hoặc xác nhận expiresAt / expireAfterSeconds: 0 trong Atlas Data Explorer.');
  }
}
