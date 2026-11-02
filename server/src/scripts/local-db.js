// Local development database without Docker: runs an embedded PostgreSQL in ./data/pg.
// Usage: npm run db:local   (then set DATABASE_URL=postgres://postgres:postgres@localhost:54320/postgres)
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dir = path.resolve('data/pg');
const port = Number(process.env.LOCAL_PG_PORT || 54320);
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
});

if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
console.log(`Local PostgreSQL running. DATABASE_URL=postgres://postgres:postgres@localhost:${port}/postgres`);
console.log('Press Ctrl+C to stop.');
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
