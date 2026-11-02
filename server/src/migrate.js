import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies every migrations/*.sql file not yet recorded in schema_migrations, each in its own transaction. */
export async function migrate(connectionString = config.migrationDatabaseUrl, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString, ssl: config.dbSsl ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  try {
    // Serialise concurrent deploys.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    log('[migrate] database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!config.migrationDatabaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  migrate().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
