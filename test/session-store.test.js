import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoSessionStore } from '../src/session/mongo-store.js';

const NOW = Date.UTC(2026, 9, 5, 8);
const DAY_MS = 86_400_000;

function createFixture() {
  let now = NOW;
  const documents = new Map();
  const calls = [];
  const failures = {};
  const reader = {
    async findOne(filter) {
      calls.push({ method: 'findOne', role: 'reader', filter: structuredClone(filter) });
      if (failures.get) throw failures.get;
      const document = documents.get(filter._id);
      if (!document || !(document.expiresAt > filter.expiresAt.$gt)) return null;
      return structuredClone(document);
    },
  };
  const writer = {
    async updateOne(filter, update, options) {
      const method = options?.upsert ? 'set' : 'touch';
      calls.push({ method: 'updateOne', role: 'writer', filter: structuredClone(filter), update: structuredClone(update), options });
      if (failures[method]) throw failures[method];
      const existing = documents.get(filter._id);
      if (filter.expiresAt && (!existing || !(existing.expiresAt > filter.expiresAt.$gt))) return { matchedCount: 0 };
      if (!existing && !options?.upsert) return { matchedCount: 0 };
      documents.set(filter._id, { _id: filter._id, ...structuredClone(existing), ...structuredClone(update.$set) });
      return { matchedCount: existing ? 1 : 0 };
    },
    async deleteOne(filter) {
      calls.push({ method: 'deleteOne', role: 'writer', filter: structuredClone(filter) });
      if (failures.destroy) throw failures.destroy;
      return { deletedCount: documents.delete(filter._id) ? 1 : 0 };
    },
  };
  const readDb = { collection: (name) => { assert.equal(name, 'sessions'); return reader; } };
  const writeDb = { collection: (name) => { assert.equal(name, 'sessions'); return writer; } };
  const store = new MongoSessionStore({ readDb, writeDb, now: () => now });
  return { store, documents, calls, failures, reader, readDb, writeDb, advance: (ms) => { now += ms; } };
}

function invoke(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

function validSession(overrides = {}) {
  return { cookie: { expires: new Date(NOW + DAY_MS), originalMaxAge: DAY_MS }, lastBookCode: '150-001', ...overrides };
}

test('session được lưu bằng writer và đọc bằng reader, serialize ngày thành JSON', async () => {
  const { store, documents, calls } = createFixture();
  const session = validSession();
  await invoke(store, 'set', 'session-id', session);
  assert.deepEqual(documents.get('session-id'), {
    _id: 'session-id', session: JSON.stringify(session), expiresAt: new Date(NOW + DAY_MS),
  });
  assert.deepEqual(await invoke(store, 'get', 'session-id'), JSON.parse(JSON.stringify(session)));
  assert.deepEqual(calls.map(({ method, role }) => [method, role]), [['updateOne', 'writer'], ['findOne', 'reader']]);
  assert.deepEqual(calls[0].filter, { _id: 'session-id' });
  assert.deepEqual(calls[0].options, { upsert: true });
  assert.deepEqual(calls[1].filter, { _id: 'session-id', expiresAt: { $gt: new Date(NOW) } });
});

test('hai Store độc lập đọc cùng phiên và dữ liệu đọc không tham chiếu payload gốc', async () => {
  const fixture = createFixture();
  const secondStore = new MongoSessionStore({ readDb: fixture.readDb, writeDb: fixture.writeDb, now: () => NOW });
  const session = validSession();
  await invoke(fixture.store, 'set', 'same-id', session);
  session.lastBookCode = '150-999';
  const retrieved = await invoke(secondStore, 'get', 'same-id');
  assert.equal(retrieved.lastBookCode, '150-001');
  retrieved.lastBookCode = '150-002';
  assert.equal((await invoke(fixture.store, 'get', 'same-id')).lastBookCode, '150-001');
});

test('get trả null với ID thiếu hoặc phiên đã hết hạn dù TTL chưa xóa', async () => {
  const { store, documents, advance } = createFixture();
  assert.equal(await invoke(store, 'get', 'missing'), null);
  await invoke(store, 'set', 'expired', validSession());
  advance(DAY_MS);
  assert.equal(await invoke(store, 'get', 'expired'), null);
  assert.equal(documents.has('expired'), true);
});

test('get phòng thủ khi adapter trả phiên hết hạn hoặc ngày không hợp lệ', async () => {
  const { store, reader } = createFixture();
  for (const expiresAt of [new Date(NOW - 1), new Date(NOW), new Date('invalid')]) {
    reader.findOne = async () => ({ session: JSON.stringify(validSession()), expiresAt });
    assert.equal(await invoke(store, 'get', 'expired'), null);
  }
});

test('set dùng ngày cookie Date/string và fallback ttlMs khi cookie không có expires', async () => {
  const { store, documents, readDb, writeDb } = createFixture();
  const shortStore = new MongoSessionStore({ readDb, writeDb, ttlMs: 1000, now: () => NOW });
  for (const expires of [new Date(NOW + 2000), new Date(NOW + 2000).toISOString()]) {
    await invoke(store, 'set', 'dated', validSession({ cookie: { expires } }));
    assert.equal(documents.get('dated').expiresAt.getTime(), NOW + 2000);
  }
  for (const session of [{ cookie: { expires: null } }, { cookie: {} }, {}]) {
    await invoke(shortStore, 'set', 'fallback', session);
    assert.equal(documents.get('fallback').expiresAt.getTime(), NOW + 1000);
  }
});

test('set từ chối expires sai định dạng trước khi truy cập writer', async () => {
  const { store, calls } = createFixture();
  for (const expires of ['invalid', new Date('invalid'), 123, false, {}]) {
    await assert.rejects(invoke(store, 'set', 'bad-date', validSession({ cookie: { expires } })), { status: 503 });
  }
  assert.equal(calls.length, 0);
});

test('touch gia hạn bằng writer, không sửa payload và không dùng upsert', async () => {
  const { store, documents, calls, advance } = createFixture();
  await invoke(store, 'set', 'active', validSession());
  const payload = documents.get('active').session;
  advance(1000);
  await invoke(store, 'touch', 'active', validSession({ cookie: { expires: new Date(NOW + DAY_MS + 1000) }, lastBookCode: '150-other' }));
  assert.equal(documents.get('active').session, payload);
  assert.equal(documents.get('active').expiresAt.getTime(), NOW + DAY_MS + 1000);
  const touch = calls.at(-1);
  assert.deepEqual(touch.filter, { _id: 'active', expiresAt: { $gt: new Date(NOW + 1000) } });
  assert.deepEqual(touch.update, { $set: { expiresAt: new Date(NOW + DAY_MS + 1000) } });
  assert.equal(touch.options, undefined);
  assert.equal(touch.role, 'writer');
});

test('touch không tạo phiên thiếu và không hồi sinh phiên hết hạn', async () => {
  const { store, documents, advance } = createFixture();
  await invoke(store, 'set', 'expired', validSession());
  advance(DAY_MS);
  const before = structuredClone(documents.get('expired'));
  await invoke(store, 'touch', 'expired', { cookie: { expires: new Date(NOW + 2 * DAY_MS) } });
  assert.deepEqual(documents.get('expired'), before);
  await invoke(store, 'touch', 'missing', validSession());
  assert.equal(documents.has('missing'), false);
});

test('destroy xóa bằng writer và chấp nhận ID không tồn tại', async () => {
  const { store, documents, calls } = createFixture();
  await invoke(store, 'set', 'deleted', validSession());
  await invoke(store, 'destroy', 'deleted');
  await invoke(store, 'destroy', 'missing');
  assert.equal(documents.has('deleted'), false);
  assert.deepEqual(calls.slice(-2).map(({ method, role }) => [method, role]), [['deleteOne', 'writer'], ['deleteOne', 'writer']]);
  assert.deepEqual(calls.at(-2).filter, { _id: 'deleted' });
});

test('các thao tác báo lỗi đã làm sạch và gọi callback đúng một lần', async (t) => {
  for (const method of ['get', 'set', 'touch', 'destroy']) {
    await t.test(method, async () => {
      const { store, failures } = createFixture();
      failures[method] = new Error('mongodb://secret-user:secret-password@host/private');
      let count = 0;
      const error = await new Promise((resolve) => {
        const args = ['set', 'touch'].includes(method) ? ['sid', validSession()] : ['sid'];
        store[method](...args, (failure) => { count += 1; resolve(failure); });
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(count, 1);
      assert.equal(error.status, 503);
      assert.equal(error.statusCode, 503);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /mongodb|secret-user|secret-password|host\/private/i);
    });
  }
});

test('lỗi đồng bộ từ adapter cũng được trả qua callback đã làm sạch', async () => {
  const { store, reader } = createFixture();
  reader.findOne = () => { throw new Error('private credentials'); };
  await assert.rejects(invoke(store, 'get', 'sid'), { status: 503 });
});

test('JSON phiên hỏng hoặc payload không phải object báo 503', async () => {
  const { store, documents } = createFixture();
  for (const session of ['{broken-json-secret', 'null', '123', '[]']) {
    documents.set('malformed', { _id: 'malformed', session, expiresAt: new Date(NOW + DAY_MS) });
    await assert.rejects(invoke(store, 'get', 'malformed'), { status: 503 });
  }
  const circular = validSession();
  circular.circular = circular;
  await assert.rejects(invoke(store, 'set', 'circular', circular), { status: 503 });
  assert.equal(documents.has('circular'), false);
});

test('TTL phải là số dương hữu hạn', () => {
  const { readDb, writeDb } = createFixture();
  for (const ttlMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => new MongoSessionStore({ readDb, writeDb, ttlMs }), TypeError);
  }
});
