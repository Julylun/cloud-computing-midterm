import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { createDatabase, readDatabaseConfig } from '../src/db/database.js';

const env = {
  MONGODB_READ_URI: 'mongodb://read_23IT150:read-secret@localhost:27017/DB_23IT150',
  MONGODB_WRITE_URI: 'mongodb://write_23IT150:write-secret@localhost:27017/DB_23IT150',
};

function fakeClients({ failConnect, failPing } = {}) {
  const calls = [];
  const documents = [{ maSach: '150001', tenSach: 'Sách thử nghiệm' }];
  class Client {
    constructor(uri, options) {
      this.role = uri.includes('read_23IT150') ? 'read' : 'write';
      calls.push({ method: 'client', role: this.role, options });
    }
    db(name) {
      const role = this.role;
      calls.push({ method: 'db', role, name });
      return {
        role,
        async command(command, options) {
          calls.push({ method: 'command', role, command, options });
          if (failPing === role) throw new Error('private MongoDB URI should not appear');
          return { ok: 1 };
        },
        collection(name) {
          calls.push({ method: 'collection', role, name });
          return {
            find(filter) {
              calls.push({ method: 'find', role, filter });
              return {
                sort(sort) {
                  calls.push({ method: 'sort', role, sort });
                  return this;
                },
                async toArray() {
                  calls.push({ method: 'toArray', role });
                  return documents;
                },
              };
            },
            async insertOne(book) {
              calls.push({ method: 'insertOne', role, book });
              return { acknowledged: true, insertedId: 'book-id' };
            },
          };
        },
      };
    }
    async connect() {
      calls.push({ method: 'connect', role: this.role });
      if (failConnect === this.role) throw new Error('mongodb://private-credentials@host');
    }
    async close() {
      calls.push({ method: 'close', role: this.role });
    }
  }
  return { Client, calls, documents };
}

test('đọc cấu hình với hai tài khoản và database đúng MSSV', () => {
  assert.deepEqual(readDatabaseConfig(env), {
    readUri: env.MONGODB_READ_URI,
    writeUri: env.MONGODB_WRITE_URI,
    databaseName: 'DB_23IT150',
  });
});

test('DNS mặc định dùng hệ thống, cấu hình tùy chọn nhận IPv4 và IPv6', () => {
  const defaultConfig = readDatabaseConfig(env);
  for (const value of [undefined, '', '  ']) {
    assert.deepEqual(readDatabaseConfig({ ...env, MONGODB_DNS_SERVERS: value }), defaultConfig);
  }
  const config = readDatabaseConfig({ ...env, MONGODB_DNS_SERVERS: ' 1.1.1.1, 8.8.8.8 , 2606:4700:4700::1111 ' });
  assert.deepEqual(config.dnsServers, ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']);
  assert.ok(Object.isFrozen(config.dnsServers));
});

test('từ chối DNS không phải IP, cổng và phần tử rỗng mà không lộ giá trị', () => {
  for (const value of [null, 123, [], 'private-resolver.invalid', '999.1.1.1', '1.1.1.1:53', '[::1]:53', ',', '1.1.1.1,', ',8.8.8.8']) {
    assert.throws(() => readDatabaseConfig({ ...env, MONGODB_DNS_SERVERS: value }), (error) => {
      assert.match(error.message, /MONGODB_DNS_SERVERS/);
      assert.doesNotMatch(error.message, /private-resolver|999\.1\.1\.1|1\.1\.1\.1:53|\[::1\]/);
      return true;
    });
  }
});

test('chỉ đổi resolver khi được cấu hình và trước khi khởi tạo hai client', () => {
  const defaultFake = fakeClients();
  createDatabase(readDatabaseConfig(env), {
    Client: defaultFake.Client,
    setDnsServers() { assert.fail('Không được đổi DNS mặc định.'); },
  });
  const fake = fakeClients();
  const servers = ['1.1.1.1', '8.8.8.8'];
  createDatabase(readDatabaseConfig({ ...env, MONGODB_DNS_SERVERS: servers.join(',') }), {
    Client: fake.Client,
    setDnsServers(values) { fake.calls.push({ method: 'setDnsServers', values }); },
  });
  assert.deepEqual(fake.calls[0], { method: 'setDnsServers', values: servers });
  assert.equal(fake.calls.filter((call) => call.method === 'client').length, 2);
});

test('resolver thất bại dừng trước khởi tạo client và không lộ lỗi', () => {
  const fake = fakeClients();
  const config = readDatabaseConfig({ ...env, MONGODB_DNS_SERVERS: '1.1.1.1' });
  assert.throws(() => createDatabase(config, {
    Client: fake.Client,
    setDnsServers() { throw new Error('private resolver failure'); },
  }), (error) => {
    assert.match(error.message, /Cấu hình kết nối MongoDB/);
    assert.doesNotMatch(error.message, /private resolver/);
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

test('chấp nhận SRV, tên tài khoản percent-encoded và MongoDB nhiều host', () => {
  const config = readDatabaseConfig({
    MONGODB_READ_URI: 'mongodb+srv://%72ead_23IT150:pass@cluster.example.com/DB_23IT150',
    MONGODB_WRITE_URI: 'mongodb://write_23IT150:pass@host1:27017,host2:27017/DB_23IT150?replicaSet=rs0',
  });
  assert.equal(config.databaseName, 'DB_23IT150');
});

test('từ chối thiếu URI, sai protocol, database và tài khoản mà không lộ URI', () => {
  const cases = [
    { ...env, MONGODB_READ_URI: undefined },
    { ...env, MONGODB_WRITE_URI: ' ' },
    { ...env, MONGODB_READ_URI: 'https://read_23IT150:secret@host/DB_23IT150' },
    { ...env, MONGODB_WRITE_URI: 'mongodb://write_23IT150:secret@host/DB_wrong' },
    { ...env, MONGODB_READ_URI: 'mongodb://read_23IT150:secret@host/' },
    { ...env, MONGODB_READ_URI: 'mongodb://other:secret@host/DB_23IT150' },
    { ...env, MONGODB_WRITE_URI: env.MONGODB_READ_URI },
    { ...env, MONGODB_READ_URI: 'mongodb://read_23IT150:bad%pass@host/DB_23IT150' },
  ];
  for (const invalidEnv of cases) {
    assert.throws(() => readDatabaseConfig(invalidEnv), (error) => {
      assert.doesNotMatch(error.message, /mongodb:\/\/|https:\/\/|secret|read-secret|write-secret|bad%pass/);
      return true;
    });
  }
});

test('truy vấn sách chỉ qua reader, thêm sách chỉ qua writer', async () => {
  const fake = fakeClients();
  const database = createDatabase(readDatabaseConfig(env), { Client: fake.Client });
  assert.equal(database.readDb.role, 'read');
  assert.equal(database.writeDb.role, 'write');
  assert.deepEqual(await database.books.list(), fake.documents);
  const book = { maSach: '150002', tenSach: 'Sách mới' };
  assert.equal((await database.books.insert(book)).insertedId, 'book-id');
  assert.deepEqual(fake.calls.filter((call) => call.method === 'find'), [
    { method: 'find', role: 'read', filter: {} },
  ]);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'sort'), [
    { method: 'sort', role: 'read', sort: { createdAt: -1, _id: -1 } },
  ]);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'insertOne'), [
    { method: 'insertOne', role: 'write', book },
  ]);
  assert.ok(fake.calls.filter((call) => call.method === 'collection').every((call) => call.name === 'books'));
});

test('kết nối, ping và đóng cả hai client với timeout hữu hạn', async () => {
  const fake = fakeClients();
  const database = createDatabase(readDatabaseConfig(env), { Client: fake.Client });
  await database.connect();
  assert.deepEqual(await database.health(), { ok: true, read: true, write: true });
  await database.close();
  assert.deepEqual(fake.calls.filter((call) => call.method === 'connect').map((call) => call.role), ['read', 'write']);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'close').map((call) => call.role), ['read', 'write']);
  for (const call of fake.calls.filter((call) => call.method === 'client')) {
    assert.deepEqual(call.options, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 4000,
      readPreference: 'primary',
    });
  }
  assert.deepEqual(fake.calls.filter((call) => call.method === 'command'), [
    { method: 'command', role: 'read', command: { ping: 1 }, options: { timeoutMS: 3000 } },
    { method: 'command', role: 'write', command: { ping: 1 }, options: { timeoutMS: 3000 } },
  ]);
});

test('một kết nối thất bại vẫn thử cả hai và đóng cả hai, không lộ lỗi driver', async () => {
  for (const role of ['read', 'write']) {
    const fake = fakeClients({ failConnect: role });
    const database = createDatabase(readDatabaseConfig(env), { Client: fake.Client });
    await assert.rejects(database.connect(), (error) => {
      assert.doesNotMatch(error.message, /private-credentials|mongodb:\/\//);
      return true;
    });
    assert.equal(fake.calls.filter((call) => call.method === 'connect').length, 2);
    assert.deepEqual(fake.calls.filter((call) => call.method === 'close').map((call) => call.role), ['read', 'write']);
  }
});

test('lỗi mạng tạm thời retry cả hai sau khi đợi đóng xong cả hai client', async () => {
  const fake = fakeClients();
  const attempts = { read: 0, write: 0 };
  let finishWriterClose;
  class TransientClient extends fake.Client {
    async connect() {
      const attempt = ++attempts[this.role];
      fake.calls.push({ method: 'connect', role: this.role, attempt });
      if (this.role === 'read' && attempt === 1) throw new MongoNetworkError('private transient failure');
    }
    close() {
      fake.calls.push({ method: 'close', role: this.role });
      if (this.role === 'write') {
        return new Promise((resolve) => {
          finishWriterClose = () => {
            fake.calls.push({ method: 'closed', role: this.role });
            resolve();
          };
        });
      }
      return Promise.resolve();
    }
  }
  const database = createDatabase(readDatabaseConfig(env), { Client: TransientClient });
  const connecting = database.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, { read: 1, write: 1 });
  assert.deepEqual(fake.calls.filter((call) => call.method === 'close').map((call) => call.role), ['read', 'write']);
  finishWriterClose();
  await connecting;
  assert.deepEqual(attempts, { read: 2, write: 2 });
  const closedIndex = fake.calls.findIndex((call) => call.method === 'closed');
  const retryIndex = fake.calls.findIndex((call) => call.method === 'connect' && call.attempt === 2);
  assert.ok(closedIndex < retryIndex);
});

test('lỗi xác thực hoặc quyền không retry kể cả khi client còn lại lỗi mạng', async () => {
  for (const code of [18, 13, 8000]) {
    for (const wrapped of ['none', 'reason', 'serverCause']) {
      const fake = fakeClients();
      const authError = new MongoServerError({ message: 'private credentials rejected', code });
      class RejectedClient extends fake.Client {
        async connect() {
          fake.calls.push({ method: 'connect', role: this.role });
          if (this.role === 'write') throw new MongoNetworkError('network failure');
          if (wrapped === 'reason') throw new MongoServerSelectionError('selection failed', { error: authError });
          if (wrapped === 'serverCause') throw new MongoServerSelectionError('selection failed', {
            servers: new Map([['private-host', { error: new MongoNetworkError('private TLS message', { cause: authError }) }]]),
          });
          throw authError;
        }
      }
      const database = createDatabase(readDatabaseConfig(env), { Client: RejectedClient });
      await assert.rejects(database.connect(), (error) => {
        assert.doesNotMatch(error.message, /private|credentials|selection failed|network failure/);
        assert.deepEqual(error.connectionFailures, [
          { role: 'reader', category: code === 18 ? 'AUTHENTICATION' : code === 13 ? 'AUTHORIZATION' : 'ATLAS_REJECTED' },
          { role: 'writer', category: 'NETWORK' },
        ]);
        assert.doesNotMatch(JSON.stringify(error), /private|credentials|selection failed|network failure/);
        return true;
      });
      assert.equal(fake.calls.filter((call) => call.method === 'connect').length, 2);
      assert.deepEqual(fake.calls.filter((call) => call.method === 'close').map((call) => call.role), ['read', 'write']);
    }
  }
});

test('lỗi mạng hoặc chọn server kéo dài chỉ thử hai lần và đóng cả hai sau mỗi lần', async () => {
  const fake = fakeClients();
  class UnreachableClient extends fake.Client {
    async connect() {
      fake.calls.push({ method: 'connect', role: this.role });
      if (this.role === 'read') throw new MongoNetworkError('private network failure');
      throw new MongoServerSelectionError('private selection failure', {});
    }
  }
  const database = createDatabase(readDatabaseConfig(env), { Client: UnreachableClient });
  await assert.rejects(database.connect(), (error) => {
    assert.doesNotMatch(error.message, /private|network failure|selection failure/);
    return true;
  });
  assert.deepEqual(fake.calls.filter((call) => ['connect', 'close'].includes(call.method)).map(({ method, role }) => [method, role]), [
    ['connect', 'read'], ['connect', 'write'], ['close', 'read'], ['close', 'write'],
    ['connect', 'read'], ['connect', 'write'], ['close', 'read'], ['close', 'write'],
  ]);
});

test('kết nối song song và đợi client còn lại kết thúc trước khi cleanup', async () => {
  const fake = fakeClients();
  let finishWriter;
  class DelayedClient extends fake.Client {
    connect() {
      fake.calls.push({ method: 'connect', role: this.role });
      if (this.role === 'read') return Promise.reject(new Error('Connection failed'));
      return new Promise((resolve) => {
        finishWriter = () => {
          fake.calls.push({ method: 'connected', role: this.role });
          resolve();
        };
      });
    }
  }
  const database = createDatabase(readDatabaseConfig(env), { Client: DelayedClient });
  const connecting = database.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.filter((call) => call.method === 'connect').length, 2);
  assert.equal(fake.calls.filter((call) => call.method === 'close').length, 0);
  finishWriter();
  await assert.rejects(connecting);
  const completedIndex = fake.calls.findIndex((call) => call.method === 'connected');
  const closeIndex = fake.calls.findIndex((call) => call.method === 'close');
  assert.ok(completedIndex < closeIndex);
});

test('health thất bại nếu một client không ping được, không lộ nội dung lỗi driver', async () => {
  const fake = fakeClients({ failPing: 'write' });
  const database = createDatabase(readDatabaseConfig(env), { Client: fake.Client });
  await assert.rejects(database.health(), (error) => {
    assert.match(error.message, /kiểm tra kết nối MongoDB/);
    assert.doesNotMatch(error.message, /private|URI/);
    return true;
  });
  assert.equal(fake.calls.filter((call) => call.method === 'command').length, 2);
});
