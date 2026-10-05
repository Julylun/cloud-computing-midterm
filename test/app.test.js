import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSessionDatabase, SESSION_SECRET } from './helpers/session-db.mjs';

function setup({ list = async () => [], insert = async () => {}, health = async () => {} } = {}) {
  const inserted = [];
  const { database } = createSessionDatabase();
  database.books.list = list;
  database.books.insert = async (book) => { inserted.push(book); await insert(book); };
  database.health = health;
  return { app: createApp({ database, sessionSecret: SESSION_SECRET }), inserted };
}
const validBook = { code: '150-001', title: 'Điện toán đám mây', author: 'Tác giả', basePrice: '100000' };

test('danh mục render footer và dữ liệu sách đã escape', async () => {
  const { app } = setup({ list: async () => [{ ...validBook, title: '<script>alert(1)</script>', basePrice: 100000, totalPrice: 105000, vatPercent: 5 }] });
  const response = await request(app).get('/books').expect(200);
  assert.match(response.text, /Hoàng Xuân Luân/);
  assert.match(response.text, /23IT150/);
  assert.match(response.text, /5%/);
  assert.match(response.text, /105\.000/);
  assert.match(response.text, /&lt;script&gt;/);
  assert.doesNotMatch(response.text, /<script>alert/);
  assert.equal(response.headers['x-powered-by'], undefined);
});
test('trang gốc chuyển tới danh mục', async () => {
  await request(setup().app).get('/').expect(302).expect('location', '/books');
});
test('POST tính VAT server, bỏ tổng/thuế client gửi và redirect 303', async () => {
  const { app, inserted } = setup();
  await request(app).post('/books').type('form').send({ ...validBook, vatPercent: 0, totalPrice: 1 }).expect(303).expect('location', '/books');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].vatPercent, 5);
  assert.equal(inserted[0].totalPrice, 105000);
  assert.ok(inserted[0].createdAt instanceof Date);
});
test('mã sai tiền tố bị từ chối trước khi ghi và giữ dữ liệu form', async () => {
  const { app, inserted } = setup();
  const response = await request(app).post('/books').type('form').send({ ...validBook, code: '999-001' }).expect(400);
  assert.equal(inserted.length, 0);
  assert.match(response.text, /999-001/);
});
test('mã trùng trả 409 và thông báo rõ ràng', async () => {
  const { app } = setup({ insert: async () => { throw Object.assign(new Error('sensitive database error'), { code: 11000 }); } });
  const response = await request(app).post('/books').type('form').send(validBook).expect(409);
  assert.match(response.text, /Mã sách đã tồn tại/);
  assert.doesNotMatch(response.text, /sensitive database error/);
});
test('chuỗi giá thập phân không được làm tròn thành số nguyên rồi lưu', async () => {
  const { app, inserted } = setup();
  for (const basePrice of ['1.0000000000000001', '100000.000000000001', '7999999999999999.5']) {
    await request(app).post('/books').type('form').send({ ...validBook, basePrice }).expect(400);
  }
  assert.equal(inserted.length, 0);
});
test('mất kết nối đọc/ghi trả 503 và không lộ lỗi driver', async () => {
  const failure = async () => { throw new Error('mongodb+srv://secret:password@example.com'); };
  const response = await request(setup({ list: failure }).app).get('/books').expect(503);
  assert.doesNotMatch(response.text, /secret|password|example\.com/);
  await request(setup({ insert: failure }).app).post('/books').type('form').send(validBook).expect(503);
});
test('health kiểm tra kết nối và báo 503 khi MongoDB không sẵn sàng', async () => {
  await request(setup().app).get('/healthz').expect(200, { status: 'ok', database: 'connected' });
  const { app } = setup({ health: async () => { throw new Error('secret'); } });
  await request(app).get('/healthz').expect(503, { status: 'unavailable' });
});
test('body quá lớn trả 413 và đường dẫn không tồn tại trả 404', async () => {
  const { app } = setup();
  await request(app).post('/books').type('form').send({ title: 'a'.repeat(17000) }).expect(413);
  await request(app).get('/khong-ton-tai').expect(404);
});
test('không khởi tạo ứng dụng bằng dữ liệu giả khi thiếu database', () => {
  assert.throws(() => createApp(), /Database chưa được cấu hình/);
});
