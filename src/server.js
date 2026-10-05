import 'dotenv/config';
import { createApp } from './app.js';
import { createDatabase, readDatabaseConfig } from './db/database.js';

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT phải là số nguyên từ 1 đến 65535.');
  }
  const database = createDatabase(readDatabaseConfig());
  await database.connect();
  const server = createApp({ database }).listen(port, '0.0.0.0', () => {
    console.log('Ứng dụng đang chạy tại http://localhost:' + port);
  });
  server.once('error', async () => {
    console.error('Không thể mở cổng HTTP. Kiểm tra PORT hoặc ứng dụng đang dùng cổng.');
    await database.close();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 5000).unref();
      server.close(async () => {
        await database.close();
        clearTimeout(deadline);
        process.exit(0);
      });
    });
  }
}
start().catch(() => {
  console.error('Không thể khởi động: kiểm tra PORT, hai URI trong .env, tài khoản và Network Access Atlas.');
  process.exitCode = 1;
});
