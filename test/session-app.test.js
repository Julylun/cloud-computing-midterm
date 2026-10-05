import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSessionDatabase, SESSION_SECRET } from './helpers/session-db.mjs';

const validBook = { code: '150-SESSION-001', title: 'Điện toán đám mây', author: 'Hoàng Xuân Luân', basePrice: '100000' };
const notice = 'Đã thêm sách thành công.';
const lastAdded = new RegExp('Sách vừa thêm:\\s*<strong>' + validBook.code + '</strong>');

function setup({ production = false } = {}) {
  const backing = createSessionDatabase();
  const newApp = () => createApp({ database: backing.database, sessionSecret: SESSION_SECRET, production });
  return { ...backing, app: newApp(), newApp };
}

function cookieOf(response) {
  const headers = response.headers['set-cookie'];
  assert.ok(headers?.length, 'Response must set a signed session cookie.');
  const header = headers.find((value) => value.startsWith('book.sid='));
  assert.ok(header, 'Cookie name must be book.sid.');
  return header.split(';')[0];
}

async function addBook(app, book = validBook, cookie) {
  let pending = request(app).post('/books').type('form').send(book);
  if (cookie) pending = pending.set('Cookie', cookie);
  return pending.expect(303).expect('location', '/books');
}

test('GET mới, static và health không tạo session hoặc cookie', async () => {
  const { app, documents, calls } = setup();
  for (const path of ['/books', '/healthz', '/styles.css']) {
    const response = await request(app).get(path).expect(200);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(documents.size, 0);
  assert.equal(calls.length, 0);
});

test('POST lưu session trước redirect; flash một lần và nhớ sách sau reload', async () => {
  const { app, documents, calls } = setup();
  const agent = request.agent(app);
  const post = await agent.post('/books').type('form').send(validBook).expect(303);
  cookieOf(post);
  assert.equal(documents.size, 1, 'Session must already be persisted when redirect is received.');
  assert.ok(calls.some(({ role, operation }) => role === 'write' && operation === 'updateOne'));
  const first = await agent.get('/books').expect(200);
  assert.match(first.text, new RegExp(notice));
  assert.match(first.text, lastAdded);
  const second = await agent.get('/books').expect(200);
  assert.doesNotMatch(second.text, new RegExp(notice));
  assert.match(second.text, lastAdded);
  assert.ok(calls.filter(({ operation }) => operation === 'findOne').every(({ role }) => role === 'read'));
  assert.ok(calls.filter(({ operation }) => operation === 'updateOne').every(({ role }) => role === 'write'));
});

test('cookie cũ dùng được trên instance thứ hai và app dựng lại từ Atlas chung', async () => {
  const { app, newApp } = setup();
  const cookie = cookieOf(await addBook(app));
  const second = await request(newApp()).get('/books').set('Cookie', cookie).expect(200);
  assert.match(second.text, new RegExp(notice));
  assert.match(second.text, lastAdded);
  const restarted = await request(newApp()).get('/books').set('Cookie', cookie).expect(200);
  assert.doesNotMatch(restarted.text, new RegExp(notice));
  assert.match(restarted.text, lastAdded);
});

test('session hết hạn bị bỏ qua dù TTL chưa xóa; POST tạo SID mới', async () => {
  const { app, documents } = setup();
  const oldCookie = cookieOf(await addBook(app));
  const [oldSid, document] = [...documents.entries()][0];
  document.expiresAt = new Date(Date.now() - 60_000);
  const expired = await request(app).get('/books').set('Cookie', oldCookie).expect(200);
  assert.doesNotMatch(expired.text, new RegExp(notice));
  assert.doesNotMatch(expired.text, /Sách vừa thêm/);
  assert.ok(documents.has(oldSid), 'Expired document remains to simulate delayed TTL deletion.');
  const regenerated = await addBook(app, { ...validBook, code: '150-SESSION-002' }, oldCookie);
  assert.notEqual(cookieOf(regenerated), oldCookie);
  assert.equal(documents.size, 2);
});

test('cookie chỉ có SID đã ký, HttpOnly/Lax và thời hạn 24 giờ; GET gia hạn', async () => {
  const { app, documents } = setup();
  const post = await addBook(app);
  const cookie = cookieOf(post);
  const fullCookie = post.headers['set-cookie'].find((value) => value.startsWith('book.sid='));
  assert.match(decodeURIComponent(cookie), /^book\.sid=s:[^.]+\.[^;]+$/);
  assert.match(fullCookie, /; HttpOnly/);
  assert.match(fullCookie, /; SameSite=Lax/);
  assert.doesNotMatch(fullCookie, /; Secure/);
  assert.doesNotMatch(decodeURIComponent(cookie), /SESSION-001|Đã thêm|Hoàng Xuân Luân/);
  const expires = new Date(/Expires=([^;]+)/.exec(fullCookie)[1]).getTime();
  assert.ok(Math.abs(expires - Date.now() - 24 * 60 * 60 * 1000) < 5000);
  const stored = [...documents.values()][0];
  assert.ok(stored.expiresAt instanceof Date);
  assert.ok(Math.abs(stored.expiresAt.getTime() - Date.now() - 24 * 60 * 60 * 1000) < 5000);
  const get = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.equal(cookieOf(get), cookie, 'Rolling renews the cookie without changing the session ID.');
  const unchanged = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.equal(cookieOf(unchanged), cookie, 'An unmodified session must also receive a renewed cookie.');
});

test('production đặt Secure qua proxy HTTPS, không gửi cookie qua HTTP', async () => {
  const { app } = setup({ production: true });
  const secure = await request(app).post('/books').set('X-Forwarded-Proto', 'https').type('form').send(validBook).expect(303);
  assert.match(secure.headers['set-cookie'][0], /; Secure/);
  assert.match(secure.headers['set-cookie'][0], /; HttpOnly/);
  assert.match(secure.headers['set-cookie'][0], /; SameSite=Lax/);
  const insecure = await request(app).post('/books').type('form').send({ ...validBook, code: '150-HTTP-001' }).expect(303);
  assert.equal(insecure.headers['set-cookie'], undefined);
});

test('Store get lỗi trả 503, không ghi sách hoặc lộ nội dung driver', async () => {
  const { app, faults, books } = setup();
  const cookie = cookieOf(await addBook(app));
  faults.readSession = new Error('mongodb://private-secret:password@example.invalid');
  const get = await request(app).get('/books').set('Cookie', cookie).expect(503);
  assert.doesNotMatch(get.text, /private-secret|password|example\.invalid|mongodb:\/\//);
  await request(app).post('/books').set('Cookie', cookie).type('form').send({ ...validBook, code: '150-FAIL-002' }).expect(503);
  assert.equal(books.length, 1);
  await request(app).get('/healthz').set('Cookie', cookie).expect(200);
  await request(app).get('/styles.css').set('Cookie', cookie).expect(200);
});

test('lỗi lưu session sau insert trả 503 và nói rõ sách đã lưu, không redirect', async () => {
  const { app, faults, books, documents } = setup();
  faults.writeSession = new Error('mongodb://private-secret:password@example.invalid');
  const response = await request(app).post('/books').type('form').send(validBook).expect(503);
  assert.equal(response.headers.location, undefined);
  assert.equal(books.length, 1);
  assert.equal(documents.size, 0);
  assert.match(response.text, /Sách đã được lưu, nhưng không thể lưu phiên\. Không cần thêm lại sách này\./);
  assert.doesNotMatch(response.text, /private-secret|password|example\.invalid|mongodb:\/\//);
});

test('đọc danh sách thất bại giữ flash để hiển thị khi Atlas phục hồi', async () => {
  const { app, faults } = setup();
  const cookie = cookieOf(await addBook(app));
  faults.listBooks = new Error('Database unavailable');
  await request(app).get('/books').set('Cookie', cookie).expect(503);
  faults.listBooks = null;
  const recovered = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.match(recovered.text, new RegExp(notice));
  const next = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.doesNotMatch(next.text, new RegExp(notice));
});

test('lưu thao tác xóa flash thất bại trả 503, còn thông báo để thử lại', async () => {
  const { app, faults } = setup();
  const cookie = cookieOf(await addBook(app));
  faults.writeSession = new Error('mongodb://private-secret:password@example.invalid');
  const failure = await request(app).get('/books').set('Cookie', cookie).expect(503);
  assert.doesNotMatch(failure.text, /private-secret|password|example\.invalid|mongodb:\/\//);
  faults.writeSession = null;
  const recovered = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.match(recovered.text, new RegExp(notice));
  const consumed = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.doesNotMatch(consumed.text, new RegExp(notice));
});

test('gia hạn phiên không đổi thất bại trả 503 trước cookie; phục hồi vẫn nhớ sách', async () => {
  const { app, faults, documents } = setup();
  const cookie = cookieOf(await addBook(app));
  await request(app).get('/books').set('Cookie', cookie).expect(200);
  const stored = [...documents.values()][0];
  const storedBeforeFailure = structuredClone(stored);
  faults.writeSession = new Error('mongodb://private-secret:password@example.invalid');
  const failed = await request(app).get('/books').set('Cookie', cookie).expect(503);
  assert.equal(failed.headers['set-cookie'], undefined, 'Do not renew a browser cookie when Atlas renewal fails.');
  assert.doesNotMatch(failed.text, /private-secret|password|example\.invalid|mongodb:\/\//);
  assert.deepEqual([...documents.values()][0], storedBeforeFailure, 'A failed touch must preserve the stored session.');

  faults.writeSession = null;
  stored.expiresAt = new Date(Date.now() + 60_000);
  const recovered = await request(app).get('/books').set('Cookie', cookie).expect(200);
  assert.equal(cookieOf(recovered), cookie);
  assert.match(recovered.text, lastAdded);
  assert.doesNotMatch(recovered.text, new RegExp(notice));
  const extended = [...documents.values()][0].expiresAt.getTime();
  assert.ok(Math.abs(extended - Date.now() - 24 * 60 * 60 * 1000) < 5000, 'Successful renewal must extend the Atlas expiry by 24 hours.');
});

test('chữ ký cookie bị sửa không đọc lại dữ liệu phiên cũ', async () => {
  const { app, calls } = setup();
  const cookie = cookieOf(await addBook(app));
  const readsBefore = calls.filter(({ operation }) => operation === 'findOne').length;
  const invalid = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  const response = await request(app).get('/books').set('Cookie', invalid).expect(200);
  assert.doesNotMatch(response.text, new RegExp(notice));
  assert.doesNotMatch(response.text, /Sách vừa thêm/);
  assert.equal(calls.filter(({ operation }) => operation === 'findOne').length, readsBefore);
});
