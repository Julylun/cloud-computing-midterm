import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

test('trang khởi tạo render tiếng Việt và footer cá nhân hóa', async () => {
  const response = await request(createApp()).get('/').expect(200);
  assert.match(response.text, /Hoàng Xuân Luân/);
  assert.match(response.text, /23IT150/);
  assert.match(response.text, /5%/);
  assert.match(response.text, /lang="vi"/);
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('health check Init hoạt động khi chưa có tài nguyên Atlas', async () => {
  await request(createApp()).get('/healthz').expect(200, { status: 'ok', stage: 'init' });
});

test('đường dẫn không tồn tại trả trang lỗi và status 404', async () => {
  const response = await request(createApp()).get('/khong-ton-tai').expect(404);
  assert.match(response.text, /không tồn tại/);
});
