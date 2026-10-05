import { MongoClient, MongoNetworkError, MongoServerSelectionError } from 'mongodb';
import { setServers } from 'node:dns';
import { isIP } from 'node:net';
import { connectionFailureCategory } from './connection-diagnostics.js';

const DATABASE_NAME = 'DB_23IT150';
const CLIENT_OPTIONS = Object.freeze({
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 4000,
  readPreference: 'primary',
});

function validateUri(value, variable, expectedUsername) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Thiếu biến môi trường ${variable}.`);
  }

  const uri = value.trim();
  let username;
  let databaseName;
  try {
    // The driver validates MongoDB syntax, including replica-set host lists.
    // Constructing a client does not establish a network connection.
    new MongoClient(uri);
    const parts = /^mongodb(?:\+srv)?:\/\/([^/?#]+)\/([^?#]*)(?:\?[^#]*)?$/.exec(uri);
    if (!parts) throw new Error('Invalid MongoDB URI');
    databaseName = decodeURIComponent(parts[2]);
    const userInfo = parts[1].slice(0, parts[1].lastIndexOf('@'));
    if (parts[1].lastIndexOf('@') === -1) throw new Error('Missing username');
    username = decodeURIComponent(userInfo.split(':')[0]);
  } catch {
    throw new Error(`${variable} phải là chuỗi kết nối MongoDB hợp lệ, có tên database và tài khoản.`);
  }

  if (databaseName !== DATABASE_NAME) {
    throw new Error(`${variable} phải chỉ định database ${DATABASE_NAME} trong đường dẫn.`);
  }
  if (username !== expectedUsername) {
    throw new Error(`${variable} phải sử dụng tài khoản ${expectedUsername}.`);
  }
  return { uri, username };
}

function readDnsServers(value) {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string') {
    throw new Error('MONGODB_DNS_SERVERS phải là danh sách địa chỉ IP, phân cách bằng dấu phẩy.');
  }
  const servers = value.split(',').map((server) => server.trim());
  if (servers.some((server) => isIP(server) === 0)) {
    throw new Error('MONGODB_DNS_SERVERS phải là danh sách địa chỉ IP hợp lệ, không có phần tử rỗng hoặc cổng.');
  }
  return Object.freeze(servers);
}

function isRetryableConnectionError(error) {
  if (!(error instanceof MongoNetworkError || error instanceof MongoServerSelectionError)) return false;
  // A server-selection wrapper can contain an authentication/authorization failure.
  return !['AUTHENTICATION', 'AUTHORIZATION', 'ATLAS_REJECTED'].includes(connectionFailureCategory(error));
}

export function readDatabaseConfig(env = process.env) {
  const reader = validateUri(env.MONGODB_READ_URI, 'MONGODB_READ_URI', 'read_23IT150');
  const writer = validateUri(env.MONGODB_WRITE_URI, 'MONGODB_WRITE_URI', 'write_23IT150');
  if (reader.username === writer.username) {
    throw new Error('Tài khoản đọc và ghi MongoDB phải độc lập.');
  }
  const dnsServers = readDnsServers(env.MONGODB_DNS_SERVERS);
  return Object.freeze({
    readUri: reader.uri,
    writeUri: writer.uri,
    databaseName: DATABASE_NAME,
    ...(dnsServers ? { dnsServers } : {}),
  });
}

export function createDatabase(config, { Client = MongoClient, setDnsServers = setServers } = {}) {
  let readClient;
  let writeClient;
  let readDb;
  let writeDb;
  try {
    // Only override Node's resolver for this process; leave the operating system untouched.
    if (config.dnsServers) setDnsServers([...config.dnsServers]);
    readClient = new Client(config.readUri, { ...CLIENT_OPTIONS });
    writeClient = new Client(config.writeUri, { ...CLIENT_OPTIONS });
    readDb = readClient.db(config.databaseName);
    writeDb = writeClient.db(config.databaseName);
  } catch {
    throw new Error('Cấu hình kết nối MongoDB không hợp lệ.');
  }

  const closeBoth = () => Promise.allSettled([
    Promise.resolve().then(() => readClient.close()),
    Promise.resolve().then(() => writeClient.close()),
  ]);

  const books = Object.freeze({
    list() {
      return readDb.collection('books').find({}).sort({ createdAt: -1, _id: -1 }).toArray();
    },
    insert(book) {
      return writeDb.collection('books').insertOne(book);
    },
  });

  return {
    books,
    readDb,
    writeDb,
    async connect() {
      let connectionFailures = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const connections = await Promise.allSettled([
          Promise.resolve().then(() => readClient.connect()),
          Promise.resolve().then(() => writeClient.connect()),
        ]);
        const failures = connections.filter((result) => result.status === 'rejected');
        if (failures.length === 0) return;
        connectionFailures = connections.flatMap((result, index) => result.status === 'rejected' ? [{
          role: index === 0 ? 'reader' : 'writer',
          category: connectionFailureCategory(result.reason),
        }] : []);
        await closeBoth();
        if (attempt === 1 || !failures.every((failure) => isRetryableConnectionError(failure.reason))) break;
      }
      throw Object.assign(new Error('Không thể kết nối MongoDB Atlas bằng hai tài khoản độc lập.'), { connectionFailures });
    },
    async close() {
      const results = await closeBoth();
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Không thể đóng toàn bộ kết nối MongoDB.');
      }
    },
    async health() {
      try {
        const pings = await Promise.all([
          readDb.command({ ping: 1 }, { timeoutMS: 3000 }),
          writeDb.command({ ping: 1 }, { timeoutMS: 3000 }),
        ]);
        if (pings.some((result) => result.ok !== 1)) throw new Error('Ping failed');
        return { ok: true, read: true, write: true };
      } catch {
        throw new Error('Không thể kiểm tra kết nối MongoDB Atlas.');
      }
    },
  };
}
