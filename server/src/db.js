import pg from 'pg';
import { config } from './config.js';

// BIGINT ids come back as strings by default; our ids stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString = config.databaseUrl) {
  return new pg.Pool({
    connectionString,
    max: config.dbPoolMax,
    ssl: config.dbSsl ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
}

export const pool = createPool();
pool.on('error', (err) => console.error('[db] idle client error', err.message));

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
