import { query } from '../db.js';

export function audit(actorId, action, { targetType = null, targetId = null, details = null, ip = null } = {}) {
  return query(
    'INSERT INTO audit_log (actor_id, action, target_type, target_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6)',
    [actorId, action, targetType, targetId, details, ip],
  ).catch((err) => console.error('[audit] failed', err.message));
}
