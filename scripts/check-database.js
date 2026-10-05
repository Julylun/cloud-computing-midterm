import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { createDatabase, readDatabaseConfig } from '../src/db/database.js';
import { buildBook } from '../src/domain/book.js';
import { student } from '../src/config/student.js';
import { isAuthorizationError } from '../src/db/errors.js';

let stage = 'Đọc cấu hình';

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

let database;
try {
  database = createDatabase(readDatabaseConfig());
  stage = 'Kết nối hai tài khoản';
  await database.connect();
  stage = 'Health check';
  await database.health();
  stage = 'Reader đọc books';
  await database.books.list();
  console.log('PASS: hai kết nối sẵn sàng, reader đọc được books.');

  const unusedId = new ObjectId();
  const book = buildBook({
    code: student.productPrefix + '-PROBE-' + randomUUID(),
    title: 'Sách kiểm chứng phân quyền',
    author: student.fullName,
    basePrice: '100000',
  });
  await denied('Reader insert books', () => database.readDb.collection('books').insertOne({ ...book, code: book.code + '-RO' }));
  await denied('Reader update books', () => database.readDb.collection('books').updateOne({ _id: unusedId }, { $set: { title: 'probe' } }));
  await denied('Reader delete books', () => database.readDb.collection('books').deleteOne({ _id: unusedId }));
  await denied('Writer find books', () => database.writeDb.collection('books').findOne({ _id: unusedId }));
  await denied('Writer update books', () => database.writeDb.collection('books').updateOne({ _id: unusedId }, { $set: { title: 'probe' } }));
  await denied('Writer delete books', () => database.writeDb.collection('books').deleteOne({ _id: unusedId }));

  stage = 'Writer thêm books';
  await database.books.insert({ ...book });
  console.log('PASS: writer thêm sách ' + book.code + '; VAT 5%, giá sau thuế 105000.');
  stage = 'Reader đọc giá sau thuế đã lưu';
  const stored = await database.readDb.collection('books').findOne({ code: book.code });
  assert.equal(stored?.totalPrice, 105000, 'Reader phải đọc lại giá sau thuế đã lưu.');
  stage = 'Unique index code';
  await assert.rejects(database.books.insert({ ...book }), (error) => error.code === 11000);
  console.log('PASS: unique index code từ chối sách trùng mã.');
  console.log('Kiểm chứng Database đạt. Bạn có thể xóa sách PROBE bằng Atlas Data Explorer.');
} catch {
  console.error('FAIL tại bước: ' + stage + '. Kiểm tra .env, Network Access, custom roles và unique index code.');
  process.exitCode = 1;
} finally {
  if (database) await database.close();
}
