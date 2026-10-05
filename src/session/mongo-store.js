import { Store } from 'express-session';

const DAY_MS = 24 * 60 * 60 * 1000;

function unavailable() {
  const error = new Error('Không thể truy cập phiên làm việc. Vui lòng thử lại.');
  error.status = 503;
  error.statusCode = 503;
  return error;
}

export class MongoSessionStore extends Store {
  constructor({ readDb, writeDb, ttlMs = DAY_MS, now = () => Date.now() }) {
    super();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('Thời hạn phiên phải là số dương.');
    }
    this.reader = readDb.collection('sessions');
    this.writer = writeDb.collection('sessions');
    this.ttlMs = ttlMs;
    this.now = now;
  }

  expiresAt(session) {
    const expires = session.cookie?.expires;
    if (expires == null) return new Date(this.now() + this.ttlMs);
    if (!(expires instanceof Date) && typeof expires !== 'string') throw unavailable();
    const date = new Date(expires);
    if (!Number.isFinite(date.getTime())) throw unavailable();
    return date;
  }

  // Keep callbacks outside the operation's rejection handler: each fires once.
  run(operation, callback = () => {}) {
    Promise.resolve().then(operation).then(
      (result) => callback(null, result),
      () => callback(unavailable()),
    );
  }

  get(sid, callback) {
    this.run(async () => {
      const currentTime = this.now();
      const document = await this.reader.findOne({
        _id: sid,
        expiresAt: { $gt: new Date(currentTime) },
      });
      if (!document) return null;
      const expiration = new Date(document.expiresAt).getTime();
      if (!Number.isFinite(expiration) || expiration <= currentTime) return null;
      const session = JSON.parse(document.session);
      if (!session || typeof session !== 'object' || Array.isArray(session)) throw unavailable();
      return session;
    }, callback);
  }

  set(sid, session, callback) {
    this.run(async () => {
      const expiresAt = this.expiresAt(session);
      const serialized = JSON.stringify(session);
      if (typeof serialized !== 'string') throw unavailable();
      await this.writer.updateOne(
        { _id: sid },
        { $set: { session: serialized, expiresAt } },
        { upsert: true },
      );
    }, callback);
  }

  touch(sid, session, callback) {
    this.run(async () => {
      const expiresAt = this.expiresAt(session);
      await this.writer.updateOne(
        { _id: sid, expiresAt: { $gt: new Date(this.now()) } },
        { $set: { expiresAt } },
      );
    }, callback);
  }

  destroy(sid, callback) {
    this.run(async () => {
      await this.writer.deleteOne({ _id: sid });
    }, callback);
  }
}
