import 'dotenv/config';
import { createApp } from './app.js';
import { createDatabase } from './db/database.js';
import { formatStartupFailure, readStartupConfig } from './config/startup.js';

let stage = 'CONFIG';
let database;

async function start() {
  const { port, sessionConfig, databaseConfig } = readStartupConfig();
  stage = 'DATABASE_INIT';
  database = createDatabase(databaseConfig);
  stage = 'ATLAS_CONNECT';
  await database.connect();
  stage = 'APP_SETUP';
  const app = createApp({ database, sessionSecret: sessionConfig.secret });
  stage = 'HTTP_LISTEN';
  const server = app.listen(port, '0.0.0.0', () => {
    console.log('Ứng dụng đang chạy tại http://localhost:' + port);
  });
  server.once('error', async () => {
    console.error(formatStartupFailure('HTTP_LISTEN'));
    try { await database.close(); }
    catch { console.error('Không thể đóng toàn bộ kết nối MongoDB.'); }
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 5000).unref();
      server.close(async () => {
        try {
          await database.close();
          clearTimeout(deadline);
          process.exit(0);
        } catch {
          console.error('Không thể đóng toàn bộ kết nối MongoDB.');
          process.exit(1);
        }
      });
    });
  }
}
start().catch(async (error) => {
  console.error(formatStartupFailure(stage, error));
  if (database) {
    try { await database.close(); }
    catch { console.error('Không thể đóng toàn bộ kết nối MongoDB.'); }
  }
  process.exitCode = 1;
});
