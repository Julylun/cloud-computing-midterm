export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function readSessionConfig(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET phải được cấu hình bằng chuỗi ngẫu nhiên tối thiểu 32 byte.');
  }
  return Object.freeze({ secret, ttlMs: SESSION_TTL_MS });
}
