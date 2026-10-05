import { readDatabaseConfig } from '../db/database.js';
import { readSessionConfig } from './session.js';

const safeConfigMessages = new Set([
  'PORT phải là số nguyên từ 1 đến 65535.',
  'SESSION_SECRET phải được cấu hình bằng chuỗi ngẫu nhiên tối thiểu 32 byte.',
  'Tài khoản đọc và ghi MongoDB phải độc lập.',
  'MONGODB_DNS_SERVERS phải là danh sách địa chỉ IP, phân cách bằng dấu phẩy.',
  'MONGODB_DNS_SERVERS phải là danh sách địa chỉ IP hợp lệ, không có phần tử rỗng hoặc cổng.',
  'Cấu hình kết nối MongoDB không hợp lệ.',
]);
for (const [variable, username] of [['MONGODB_READ_URI', 'read_23IT150'], ['MONGODB_WRITE_URI', 'write_23IT150']]) {
  safeConfigMessages.add(`Thiếu biến môi trường ${variable}.`);
  safeConfigMessages.add(`${variable} phải là chuỗi kết nối MongoDB hợp lệ, có tên database và tài khoản.`);
  safeConfigMessages.add(`${variable} phải chỉ định database DB_23IT150 trong đường dẫn.`);
  safeConfigMessages.add(`${variable} phải sử dụng tài khoản ${username}.`);
}

function configFailure(stage, error) {
  const message = safeConfigMessages.has(error?.message) ? error.message : 'Cấu hình khởi động không hợp lệ.';
  return Object.assign(new Error(message), { startupStage: stage });
}

export function readStartupConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configFailure('PORT', new Error('PORT phải là số nguyên từ 1 đến 65535.'));
  }
  let sessionConfig;
  let databaseConfig;
  try { sessionConfig = readSessionConfig(env); }
  catch (error) { throw configFailure('SESSION_CONFIG', error); }
  try { databaseConfig = readDatabaseConfig(env); }
  catch (error) { throw configFailure('DATABASE_CONFIG', error); }
  return { port, sessionConfig, databaseConfig };
}

const stageMessages = {
  CONFIG: 'Kiểm tra cấu hình môi trường trên Render.',
  PORT: 'Kiểm tra PORT do Render cung cấp.',
  SESSION_CONFIG: 'Kiểm tra SESSION_SECRET trên Render.',
  DATABASE_CONFIG: 'Kiểm tra hai URI và database DB_23IT150 trên Render.',
  DATABASE_INIT: 'Không thể khởi tạo kết nối MongoDB; kiểm tra cấu hình DNS.',
  ATLAS_CONNECT: 'Không thể kết nối Atlas; kiểm tra hai user và toàn bộ outbound CIDR của Render.',
  APP_SETUP: 'Không thể khởi tạo ứng dụng.',
  HTTP_LISTEN: 'Không thể mở cổng HTTP; kiểm tra PORT hoặc cổng đang được sử dụng.',
};
const connectionMessages = {
  AUTHENTICATION: 'xác thực thất bại; kiểm tra username và mật khẩu trong URI',
  AUTHORIZATION: 'Atlas từ chối quyền truy cập',
  ATLAS_REJECTED: 'Atlas từ chối kết nối; kiểm tra hai user và thông tin xác thực',
  DNS: 'không phân giải được DNS Atlas',
  TLS_ALERT: 'TLS handshake bị từ chối; kiểm tra outbound CIDR Render trong Atlas Network Access',
  TLS_CERTIFICATE: 'không xác minh được chứng chỉ TLS',
  NETWORK: 'lỗi mạng hoặc timeout; kiểm tra outbound CIDR Render trong Atlas Network Access',
  UNKNOWN: 'kết nối thất bại',
};

export function formatStartupFailure(stage, error) {
  const actualStage = Object.hasOwn(stageMessages, error?.startupStage) ? error.startupStage : stage;
  const knownStage = Object.hasOwn(stageMessages, actualStage) ? actualStage : 'CONFIG';
  let message = stageMessages[knownStage];
  if (safeConfigMessages.has(error?.message)) message = error.message;
  if (knownStage === 'ATLAS_CONNECT' && Array.isArray(error?.connectionFailures)) {
    const details = error.connectionFailures
      .filter((failure) => ['reader', 'writer'].includes(failure?.role))
      .map((failure) => `${failure.role}: ${Object.hasOwn(connectionMessages, failure.category) ? connectionMessages[failure.category] : connectionMessages.UNKNOWN}`);
    if (details.length) message = details.join('; ') + '.';
  }
  return `Không thể khởi động [${knownStage}]: ${message}`;
}
