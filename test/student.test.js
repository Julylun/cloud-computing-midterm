import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudentProfile, student } from '../src/config/student.js';

test('cá nhân hóa đúng MSSV 23IT150', () => {
  assert.equal(student.productPrefix, '150');
  assert.equal(student.vatPercent, 5);
  assert.equal(student.databaseName, 'DB_23IT150');
});

test('VAT và tiền tố thay đổi theo MSSV, không cố định ở 5%', () => {
  const other = createStudentProfile({ fullName: 'Sinh viên', studentId: '23IT159' });
  assert.equal(other.vatPercent, 14);
  assert.equal(other.productPrefix, '159');
});

test('giữ chữ số 0 đầu tiền tố và từ chối MSSV không có đủ ba số cuối', () => {
  assert.equal(createStudentProfile({ fullName: 'Sinh viên', studentId: '23IT009' }).productPrefix, '009');
  assert.throws(() => createStudentProfile({ fullName: 'Sinh viên', studentId: '23IT15A' }));
});
