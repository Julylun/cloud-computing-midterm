import { student } from '../config/student.js';

export class BookValidationError extends Error {
  constructor(errors) {
    super('Thông tin sách chưa hợp lệ.');
    this.name = 'BookValidationError';
    this.errors = errors;
  }
}

export function buildBook(input, profile = student) {
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = {};
  const code = typeof values.code === 'string' ? values.code.trim() : '';
  const title = typeof values.title === 'string' ? values.title.trim() : '';
  const author = typeof values.author === 'string' ? values.author.trim() : '';

  if (!code || !code.startsWith(profile.productPrefix)) {
    errors.code = `Mã sách phải bắt đầu bằng ${profile.productPrefix}.`;
  }
  if (!title) errors.title = 'Vui lòng nhập tên sách.';
  if (!author) errors.author = 'Vui lòng nhập tác giả.';

  const priceInput = values.basePrice;
  const isPriceValue = typeof priceInput === 'number'
    || (typeof priceInput === 'string' && /^\d+$/.test(priceInput.trim()));
  const basePrice = isPriceValue ? Number(priceInput) : NaN;
  let totalPrice;
  if (!Number.isSafeInteger(basePrice) || basePrice <= 0) {
    errors.basePrice = 'Giá trước thuế phải là số nguyên VND dương trong giới hạn an toàn.';
  } else {
    // Keep multiplication exact even near Number.MAX_SAFE_INTEGER, rounding half up to VND.
    const rounded = (BigInt(basePrice) * BigInt(100 + profile.vatPercent) + 50n) / 100n;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
      errors.basePrice = 'Giá sau thuế vượt quá giới hạn an toàn.';
    } else {
      totalPrice = Number(rounded);
    }
  }

  if (Object.keys(errors).length > 0) throw new BookValidationError(errors);

  return {
    code,
    title,
    author,
    basePrice,
    vatPercent: profile.vatPercent,
    totalPrice,
    createdAt: new Date(),
  };
}
