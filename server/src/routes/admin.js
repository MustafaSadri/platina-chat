import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, asyncH, parse } from '../middleware.js';
import { deleteUserSessions, generateTempPassword, hashPassword, publicUser } from '../services/auth.js';
import { audit } from '../services/audit.js';
import * as chats from '../services/chats.js';
import { getRetentionDays, runRetention } from '../services/retention.js';
import { broadcast, disconnectUser, toUsers } from '../realtime/bus.js';

const router = Router();
const id = z.coerce.number().int().positive();
const idParam = (req, name = 'id') => parse(id, req.params[name]);

function adminUser(u) {
  return {
    ...publicUser(u),
    mustChangePassword: u.must_change_password,
    canCreateGroups: u.can_create_groups,
    canStartDirect: u.can_start_direct,
    createdAt: u.created_at,
    removedAt: u.removed_at,
  };
}

async function loadUser(userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
  return rows[0];
}

/** Revokes every session and live socket of a user, effective immediately. */
async function revokeAccess(userId) {
  await deleteUserSessions(userId); // also removes their push subscriptions
  disconnectUser(userId);
  broadcast('presence', { userId, online: false, lastSeenAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

router.get('/users', asyncH(async (req, res) => {
  const { rows } = await query(`SELECT * FROM users ORDER BY status = 'removed', lower(display_name)`);
  res.json({ users: rows.map(adminUser) });
}));

const usernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore');
const userFields = {
  displayName: z.string().trim().min(1).max(64),
  title: z.string().trim().max(64).optional(),
  role: z.enum(['admin', 'employee']).optional(),
  canCreateGroups: z.boolean().optional(),
  canStartDirect: z.boolean().optional(),
};

router.post('/users', asyncH(async (req, res) => {
  const data = parse(z.object({ username: usernameSchema, ...userFields }), req.body);
  const tempPassword = generateTempPassword();
  let row;
  try {
    ({ rows: [row] } = await query(
      `INSERT INTO users (username, display_name, title, role, can_create_groups, can_start_direct, password_hash, must_change_password, avatar_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8) RETURNING *`,
      [data.username, data.displayName, data.title || '', data.role || 'employee', data.canCreateGroups ?? false,
        data.canStartDirect ?? true, await hashPassword(tempPassword), Math.floor(Math.random() * 8)],
    ));
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'That username is already taken.', 'USERNAME_TAKEN');
    throw err;
  }
  audit(req.user.id, 'user_created', { targetType: 'user', targetId: row.id, details: { username: row.username }, ip: req.ip });
  broadcast('directory:changed', {});
  // The temporary password is shown once to the admin and never stored in plain text.
  res.status(201).json({ user: adminUser(row), tempPassword });
}));

router.patch('/users/:id', asyncH(async (req, res) => {
  const userId = idParam(req);
  const data = parse(z.object(userFields).partial(), req.body);
  const user = await loadUser(userId);
  if (userId === req.user.id && data.role && data.role !== 'admin') {
    throw new HttpError(400, 'You cannot remove your own administrator role.', 'VALIDATION');
  }
  const { rows } = await query(
    `UPDATE users SET display_name = coalesce($2, display_name), title = coalesce($3, title), role = coalesce($4, role),
            can_create_groups = coalesce($5, can_create_groups), can_start_direct = coalesce($6, can_start_direct)
      WHERE id = $1 RETURNING *`,
    [userId, data.displayName ?? null, data.title ?? null, data.role ?? null, data.canCreateGroups ?? null, data.canStartDirect ?? null],
  );
  audit(req.user.id, 'user_updated', { targetType: 'user', targetId: userId, details: data, ip: req.ip });
  toUsers([userId], 'me:updated', {});
  if (user.display_name !== rows[0].display_name || user.title !== rows[0].title) broadcast('directory:changed', {});
  res.json({ user: adminUser(rows[0]) });
}));

router.post('/users/:id/reset-password', asyncH(async (req, res) => {
  const userId = idParam(req);
  const user = await loadUser(userId);
  if (user.status === 'removed') throw new HttpError(400, 'This user has been removed.', 'VALIDATION');
  const tempPassword = generateTempPassword();
  await query(
    'UPDATE users SET password_hash = $2, must_change_password = TRUE, password_changed_at = now() WHERE id = $1',
    [userId, await hashPassword(tempPassword)],
  );
  await deleteUserSessions(userId);
  disconnectUser(userId);
  audit(req.user.id, 'password_reset', { targetType: 'user', targetId: userId, ip: req.ip });
  res.json({ tempPassword });
}));

router.post('/users/:id/deactivate', asyncH(async (req, res) => {
  const userId = idParam(req);
  if (userId === req.user.id) throw new HttpError(400, 'You cannot deactivate yourself.', 'VALIDATION');
  const { rows } = await query(`UPDATE users SET status = 'deactivated' WHERE id = $1 AND status = 'active' RETURNING *`, [userId]);
  if (!rows[0]) throw new HttpError(400, 'User is not active.', 'VALIDATION');
  await revokeAccess(userId);
  audit(req.user.id, 'user_deactivated', { targetType: 'user', targetId: userId, ip: req.ip });
  broadcast('directory:changed', {});
  res.json({ user: adminUser(rows[0]) });
}));

router.post('/users/:id/reactivate', asyncH(async (req, res) => {
  const userId = idParam(req);
  const { rows } = await query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'deactivated' RETURNING *`, [userId]);
  if (!rows[0]) throw new HttpError(400, 'Only deactivated users can be reactivated.', 'VALIDATION');
  audit(req.user.id, 'user_reactivated', { targetType: 'user', targetId: userId, ip: req.ip });
  broadcast('directory:changed', {});
  res.json({ user: adminUser(rows[0]) });
}));

/**
 * Removes an employee: access is revoked immediately and they leave all groups, but their past
 * messages stay in the database (subject to the retention policy) so business history is preserved.
 */
router.delete('/users/:id', asyncH(async (req, res) => {
  const userId = idParam(req);
  if (userId === req.user.id) throw new HttpError(400, 'You cannot remove yourself.', 'VALIDATION');
  const { rows } = await query(
    `UPDATE users SET status = 'removed', removed_at = now() WHERE id = $1 AND status <> 'removed' RETURNING *`,
    [userId],
  );
  if (!rows[0]) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
  await revokeAccess(userId);
  const groups = await query(
    `DELETE FROM chat_members cm USING chats c
      WHERE cm.chat_id = c.id AND c.type = 'group' AND cm.user_id = $1 RETURNING cm.chat_id, cm.role`,
    [userId],
  );
  for (const g of groups.rows) {
    if (g.role === 'owner') {
      await query(
        `UPDATE chat_members SET role = 'owner' WHERE (chat_id, user_id) = (
           SELECT chat_id, user_id FROM chat_members WHERE chat_id = $1 ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1)`,
        [g.chat_id],
      );
    }
    await chats.postSystemMessage(g.chat_id, req.user.id, 'member_removed', { userId });
    await chats.pushChatSummaries(g.chat_id);
  }
  audit(req.user.id, 'user_removed', { targetType: 'user', targetId: userId, details: { username: rows[0].username }, ip: req.ip });
  broadcast('directory:changed', {});
  res.json({ user: adminUser(rows[0]) });
}));

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

router.get('/groups', asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.title, c.description, c.only_admins_post, c.members_can_add, c.created_at,
            (SELECT count(*)::int FROM chat_members cm WHERE cm.chat_id = c.id) AS member_count,
            (SELECT max(m.created_at) FROM messages m WHERE m.chat_id = c.id) AS last_activity
       FROM chats c WHERE c.type = 'group' AND c.archived_at IS NULL ORDER BY lower(c.title)`,
  );
  res.json({
    groups: rows.map((g) => ({
      id: g.id, title: g.title, description: g.description, onlyAdminsPost: g.only_admins_post,
      membersCanAdd: g.members_can_add, memberCount: g.member_count, lastActivity: g.last_activity, createdAt: g.created_at,
    })),
  });
}));

router.get('/groups/:id', asyncH(async (req, res) => {
  const chatId = idParam(req);
  const g = await chats.requireGroupManager(chatId, req.user);
  const { rows } = await query(
    `SELECT u.*, cm.role AS member_role FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = $1 ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`,
    [chatId],
  );
  res.json({
    group: {
      id: g.id, title: g.title, description: g.description, onlyAdminsPost: g.only_admins_post, membersCanAdd: g.members_can_add,
      members: rows.map((u) => ({ ...publicUser(u), memberRole: u.member_role })),
    },
  });
}));

router.post('/groups', asyncH(async (req, res) => {
  const data = parse(z.object({
    title: z.string().trim().min(1).max(128),
    description: z.string().trim().max(1000).optional(),
    memberIds: z.array(id).max(1000).default([]),
    ownerId: id.optional(),
    includeSelf: z.boolean().default(false),
    onlyAdminsPost: z.boolean().optional(),
    membersCanAdd: z.boolean().optional(),
  }), req.body);
  const chatId = await chats.createGroup(req.user, data);
  if (data.ownerId && data.ownerId !== req.user.id) {
    await query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (chat_id, user_id) DO UPDATE SET role = 'owner'`,
      [chatId, data.ownerId],
    );
    await chats.pushChatSummaries(chatId);
  }
  audit(req.user.id, 'group_created', { targetType: 'chat', targetId: chatId, details: { title: data.title }, ip: req.ip });
  res.status(201).json({ id: chatId });
}));

router.delete('/groups/:id', asyncH(async (req, res) => {
  const chatId = idParam(req);
  await chats.requireGroupManager(chatId, req.user);
  const members = await query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  // Archived, not deleted: history remains for retention/compliance.
  await query('UPDATE chats SET archived_at = now() WHERE id = $1', [chatId]);
  toUsers(members.rows.map((r) => r.user_id), 'chat:removed', { chatId });
  audit(req.user.id, 'group_archived', { targetType: 'chat', targetId: chatId, ip: req.ip });
  res.json({ ok: true });
}));

// Group edits and membership changes reuse the /api/chats endpoints, which allow global admins.

// ---------------------------------------------------------------------------
// Settings & audit
// ---------------------------------------------------------------------------

router.get('/settings', asyncH(async (req, res) => {
  res.json({ retentionDays: await getRetentionDays() });
}));

router.put('/settings', asyncH(async (req, res) => {
  const { retentionDays } = parse(z.object({ retentionDays: z.number().int().min(0).max(36500) }), req.body);
  await query(`UPDATE settings SET value = $1 WHERE key = 'retention_days'`, [JSON.stringify(retentionDays)]);
  audit(req.user.id, 'retention_changed', { details: { retentionDays }, ip: req.ip });
  res.json({ retentionDays });
}));

router.post('/retention/run', asyncH(async (req, res) => {
  res.json(await runRetention());
}));

router.get('/audit', asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.display_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 300`,
  );
  res.json({
    entries: rows.map((a) => ({
      id: a.id, actorId: a.actor_id, actorName: a.actor_name, action: a.action, targetType: a.target_type,
      targetId: a.target_id, details: a.details, ip: a.ip, createdAt: a.created_at,
    })),
  });
}));

export default router;
