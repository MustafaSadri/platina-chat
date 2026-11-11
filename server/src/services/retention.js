import { query } from '../db.js';
import { storage } from './storage.js';

export async function getRetentionDays() {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'retention_days'`);
  return Number(rows[0]?.value || 0);
}

/**
 * Applies the retention policy: messages older than retention_days (0 = keep forever) are
 * permanently deleted together with files no longer referenced. Also prunes expired sessions.
 */
export async function runRetention() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  const days = await getRetentionDays();
  if (!days) return { deletedMessages: 0, deletedFiles: 0 };
  const del = await query(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [days]);
  await query(`DELETE FROM message_reads WHERE read_at < now() - make_interval(days => $1)`, [days]);
  const orphans = await query(
    `DELETE FROM files f WHERE f.created_at < now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)
      RETURNING storage_key`,
    [days],
  );
  for (const { storage_key: key } of orphans.rows) {
    await storage.remove(key).catch((err) => console.error('[retention] remove failed', key, err.message));
  }
  return { deletedMessages: del.rowCount, deletedFiles: orphans.rowCount };
}

export function scheduleRetention() {
  const run = () => runRetention()
    .then((r) => (r.deletedMessages || r.deletedFiles) && console.log('[retention]', r))
    .catch((err) => console.error('[retention] failed', err.message));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}
