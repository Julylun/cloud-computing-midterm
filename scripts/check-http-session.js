import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase, readDatabaseConfig } from '../src/db/database.js';
import { readSessionConfig } from '../src/config/session.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
const bookCode = '150-HTTP-PROBE-' + randomUUID();
let stage = 'Đọc cấu hình';
let database;
let sid;
let verified = false;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(port, attempt = 0) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.add(child);
  let failed = false;
  child.once('error', () => { failed = true; });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !failed && child.exitCode === null) {
    try {
      const response = await fetch('http://localhost:' + port + '/healthz', { signal: AbortSignal.timeout(4000) });
      if (response.status === 200) return child;
    } catch { /* Wait for the child to connect to Atlas and listen. */ }
    await delay(250);
  }
  await stopServer(child);
  if (attempt < 2) {
    await delay(1000);
    return startServer(port, attempt + 1);
  }
  throw new Error('Tiến trình HTTP chưa sẵn sàng sau ba lần khởi động.');
}

async function stopServer(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(6000, undefined, { ref: false }).then(() => false)]);
  if (!stopped) {
    child.kill('SIGKILL');
    await exited;
  }
  children.delete(child);
}

async function getBooks(port, cookie) {
  const response = await fetch('http://localhost:' + port + '/books', {
    headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('Sách vừa thêm: <strong>' + bookCode + '</strong>'));
  assert.match(html, /105\.000/);
  return html;
}

try {
  readSessionConfig();
  database = createDatabase(readDatabaseConfig());
  stage = 'Kết nối hai tài khoản Atlas';
  await database.connect();
  const firstPort = await freePort();
  stage = 'Khởi động tiến trình Node thứ nhất';
  const first = await startServer(firstPort);
  const secondPort = await freePort();
  assert.notEqual(secondPort, firstPort);
  stage = 'Khởi động tiến trình Node thứ hai';
  let second = await startServer(secondPort);
  console.log('PASS: hai tiến trình HTTP kết nối Atlas độc lập.');

  stage = 'POST lưu sách và phiên trước redirect';
  const response = await fetch('http://localhost:' + firstPort + '/books', {
    method: 'POST',
    body: new URLSearchParams({ code: bookCode, title: 'Sách kiểm chứng HTTP Session', author: 'Hoàng Xuân Luân', basePrice: '100000' }),
    redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/books');
  const fullCookie = response.headers.getSetCookie().find((value) => value.startsWith('book.sid='));
  assert.ok(fullCookie);
  assert.match(fullCookie, /; HttpOnly/);
  assert.match(fullCookie, /; SameSite=Lax/);
  const cookie = fullCookie.split(';')[0];
  const signedId = decodeURIComponent(cookie.slice('book.sid='.length));
  assert.match(signedId, /^s:[^.]+\.[^;]+$/);
  sid = signedId.slice(2).split('.')[0];
  const stored = await database.readDb.collection('sessions').findOne({ _id: sid });
  assert.ok(stored?.expiresAt instanceof Date);
  assert.equal(JSON.parse(stored.session).lastAddedBookCode, bookCode);
  console.log('PASS: redirect 303 chỉ được gửi sau khi phiên đã lưu trên Atlas.');

  stage = 'Instance thứ hai đọc cookie và hiển thị flash';
  const firstRead = await getBooks(secondPort, cookie);
  assert.ok(firstRead.includes('Đã thêm sách thành công.'));
  stage = 'Instance thứ nhất nhớ sách, không lặp flash';
  const nextRead = await getBooks(firstPort, cookie);
  assert.ok(!nextRead.includes('Đã thêm sách thành công.'));
  console.log('PASS: cùng cookie dùng được trên hai instance; flash xuất hiện một lần.');

  stage = 'Restart tiến trình thứ hai';
  await stopServer(second);
  second = await startServer(secondPort);
  const restarted = await getBooks(secondPort, cookie);
  assert.ok(!restarted.includes('Đã thêm sách thành công.'));
  console.log('PASS: tiến trình mới vẫn nhớ mã sách vừa thêm từ Atlas.');
  await stopServer(first);
  await stopServer(second);
  verified = true;
} catch {
  console.error('FAIL tại bước: ' + stage + '. Kiểm tra cấu hình Atlas và Session.');
  process.exitCode = 1;
} finally {
  for (const child of children) {
    try { await stopServer(child); } catch { process.exitCode = 1; }
  }
  if (database) {
    try {
      if (sid) await database.writeDb.collection('sessions').deleteOne({ _id: sid });
    } catch {
      console.error('FAIL: không thể dọn phiên kiểm chứng.');
      process.exitCode = 1;
    }
    try {
      await database.close();
    } catch {
      console.error('FAIL: không thể đóng kết nối.');
      process.exitCode = 1;
    }
  }
}
if (verified && !process.exitCode) {
  console.log('Kiểm chứng HTTP Session đạt; phiên PROBE đã được dọn.');
  console.log('Sách PROBE được giữ trong books: ' + bookCode + '. Có thể xóa bằng Atlas Data Explorer.');
}
