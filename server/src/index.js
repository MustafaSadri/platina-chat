import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig, config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import { createSocketServer } from './realtime/socket.js';
import { scheduleRetention } from './services/retention.js';
import { storage } from './services/storage.js';
import { migrate } from './migrate.js';

export async function start({ port = config.port, runMigrations = process.env.MIGRATE_ON_START !== 'false', handleSignals = true } = {}) {
  assertConfig();
  if (runMigrations) await migrate(config.migrationDatabaseUrl);
  await storage.check().catch((err) => console.error('[storage] check failed:', err.message));
  const app = createApp();
  const server = http.createServer(app);
  const io = await createSocketServer(server);
  scheduleRetention();
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[server] listening on :${server.address().port} (${config.isProd ? 'production' : 'development'}, storage=${config.storage.driver})`);

  if (handleSignals) {
    const shutdown = async () => {
      console.log('[server] shutting down');
      io.close();
      server.close();
      await pool.end().catch(() => {});
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
  return { server, io };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().catch((err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });
}
