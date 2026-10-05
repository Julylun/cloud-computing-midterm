import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBook, BookValidationError } from '../src/domain/book.js';
import { createStudentProfile } from '../src/config/student.js';

const validInput = { code: '150-001', title: 'Sách điện toán đám mây', author: 'Tác giả', basePrice: '100000' };

function assertInvalid(input, fields) {
  assert.throws(() => buildBook(input), (error) => {
    assert.ok(error instanceof BookValidationError);
    assert.equal(error.name, 'BookValidationError');
    assert.deepEqual(Object.keys(error.errors).sort(), [...fields].sort());
    for (const message of Object.values(error.errors)) assert.equal(typeof message, 'string');
    return true;
  });
}

test('trims book values and computes the personalized VAT instead of trusting posted totals', () => {
  const before = new Date();
  const book = buildBook({
    ...validInput, code: ' 150-001 ', title: ' Sách điện toán đám mây ', author: ' Tác giả ',
    vatPercent: 99, totalPrice: 1, extra: 'ignored',
  });
  assert.deepEqual({ ...book, createdAt: undefined }, {
    code: '150-001', title: 'Sách điện toán đám mây', author: 'Tác giả',
    basePrice: 100000, vatPercent: 5, totalPrice: 105000, createdAt: undefined,
  });
  assert.ok(book.createdAt instanceof Date);
  assert.ok(book.createdAt >= before && book.createdAt <= new Date());
});

test('derives the book prefix and VAT from an alternate student profile', () => {
  const profile = createStudentProfile({ fullName: 'Sinh viên khác', studentId: '23IT159' });
  const book = buildBook({ ...validInput, code: '159-001' }, profile);
  assert.equal(book.vatPercent, 14);
  assert.equal(book.totalPrice, 114000);
  assert.throws(() => buildBook(validInput, profile), BookValidationError);
});

test('accepts any suffix after the required prefix and numeric prices', () => {
  for (const code of ['150', '150invalid0', '150-sach']) {
    assert.equal(buildBook({ ...validInput, code, basePrice: 100000 }).code, code);
  }
});

test('rounds tax-inclusive prices to the nearest VND with exact half-up arithmetic', () => {
  assert.equal(buildBook({ ...validInput, basePrice: 1 }).totalPrice, 1);
  assert.equal(buildBook({ ...validInput, basePrice: 10 }).totalPrice, 11);
  assert.equal(buildBook({ ...validInput, basePrice: 30 }).totalPrice, 32);
  const basePrice = 8000000000000010;
  const expected = Number((BigInt(basePrice) * 105n + 50n) / 100n);
  assert.equal(buildBook({ ...validInput, basePrice }).totalPrice, expected);
});

test('rejects missing input and collects all missing field errors', () => {
  for (const input of [undefined, null, {}, [], 'input']) {
    assertInvalid(input, ['code', 'title', 'author', 'basePrice']);
  }
});

test('rejects a different prefix and blank required strings', () => {
  assertInvalid({ ...validInput, code: '151-001' }, ['code']);
  assertInvalid({ ...validInput, code: '  ', title: '\t', author: '\n' }, ['code', 'title', 'author']);
});

test('rejects arrays and objects instead of coercing them into form strings', () => {
  for (const value of [[], ['150'], {}, { value: '150' }, 150, null]) {
    for (const field of ['code', 'title', 'author']) {
      assertInvalid({ ...validInput, [field]: value }, [field]);
    }
  }
});

test('rejects invalid or unsafe prices including an unsafe tax-inclusive result', () => {
  for (const basePrice of [
    0, -1, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER, '', ' ', 'text', '-1', '1.1', 'Infinity',
    [], ['100000'], {}, null, true,
  ]) {
    assertInvalid({ ...validInput, basePrice }, ['basePrice']);
  }
});
