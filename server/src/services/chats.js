import { query, tx } from '../db.js';
import { HttpError } from '../middleware.js';
import { publicUser } from './auth.js';
import { toChat, toUsers, chatMemberIds } from '../realtime/bus.js';
import { notifyNewMessage } from './push.js';

const randomColor = () => Math.floor(Math.random() * 8);

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export const MESSAGE_SELECT = `
SELECT m.id, m.chat_id, m.sender_id, m.client_id, m.type, m.body, m.meta, m.created_at, m.edited_at, m.deleted_at,
       m.forwarded_from_id, m.forwarded_name,
       f.id AS f_id, f.file_name AS f_name, f.mime_type AS f_mime, f.size_bytes AS f_size, f.kind AS f_kind,
       f.width AS f_w, f.height AS f_h, f.duration_sec AS f_dur, f.waveform AS f_wave,
       r.id AS r_id, r.sender_id AS r_sender_id, r.type AS r_type, r.body AS r_body, r.deleted_at AS r_deleted_at,
       rf.kind AS r_f_kind, rf.file_name AS r_f_name,
       (SELECT json_agg(json_build_object('emoji', q.emoji, 'userIds', q.uids) ORDER BY q.t)
          FROM (SELECT emoji, array_agg(user_id ORDER BY created_at) AS uids, min(created_at) AS t
                  FROM message_reactions WHERE message_id = m.id GROUP BY emoji) q) AS reactions
  FROM messages m
  LEFT JOIN files f ON f.id = m.file_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN files rf ON rf.id = r.file_id`;

export function serializeFile(row, prefix = 'f_') {
  if (!row[`${prefix}id`]) return null;
  return {
    id: row[`${prefix}id`],
    name: row[`${prefix}name`],
    mime: row[`${prefix}mime`],
    size: row[`${prefix}size`],
    kind: row[`${prefix}kind`],
    width: row[`${prefix}w`],
    height: row[`${prefix}h`],
    duration: row[`${prefix}dur`],
    waveform: row[`${prefix}wave`],
    url: `/api/files/${row[`${prefix}id`]}`,
  };
}

export function serializeMessage(row) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    type: row.type,
    body: deleted ? '' : row.body,
    file: deleted ? null : serializeFile(row),
    meta: row.meta,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted,
    forwardedFrom: row.forwarded_name ? { userId: row.forwarded_from_id, name: row.forwarded_name } : null,
    replyTo: row.r_id
      ? {
          id: row.r_id,
          senderId: row.r_sender_id,
          type: row.r_type,
          body: row.r_deleted_at ? '' : (row.r_body || '').slice(0, 200),
          fileKind: row.r_deleted_at ? null : row.r_f_kind,
          fileName: row.r_deleted_at ? null : row.r_f_name,
          deleted: !!row.r_deleted_at,
        }
      : null,
    reactions: row.reactions || [],
  };
}

export async function getMessage(id, db = { query }) {
  const { rows } = await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? serializeMessage(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Membership & permissions
// ---------------------------------------------------------------------------

/** Returns the chat joined with the user's membership, or throws 404 (never reveal chats you can't see). */
export async function requireMember(chatId, userId) {
  const { rows } = await query(
    `SELECT c.*, cm.role AS my_role, cm.cleared_before_id, cm.last_read_id
       FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
      WHERE c.id = $1 AND c.archived_at IS NULL`,
    [chatId, userId],
  );
  if (!rows[0]) throw new HttpError(404, 'Chat not found.', 'NOT_FOUND');
  return rows[0];
}

const isChatAdmin = (chat) => ['owner', 'admin'].includes(chat.my_role);

export function assertCanPost(chat) {
  if (chat.type === 'group' && chat.only_admins_post && !isChatAdmin(chat)) {
    throw new HttpError(403, 'Only group admins can post in this group.', 'FORBIDDEN');
  }
}

async function assertDirectPeerActive(chat, userId) {
  if (chat.type !== 'direct') return;
  const { rows } = await query(
    `SELECT u.status FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = $1 AND cm.user_id <> $2`,
    [chat.id, userId],
  );
  if (rows[0] && rows[0].status !== 'active') throw new HttpError(403, 'This user is no longer active.', 'PEER_INACTIVE');
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

export async function getChatSummaries(userId, chatIds = null) {
  const { rows } = await query(
    `SELECT c.id, c.type, c.title, c.description, c.only_admins_post, c.members_can_add, c.avatar_color, c.created_at,
            cm.role AS my_role, cm.last_read_id, cm.last_delivered_id, cm.muted, cm.pinned, cm.archived, cm.auto_translate,
            (SELECT coalesce(max(o.last_read_id), 0) FROM chat_members o WHERE o.chat_id = c.id AND o.user_id <> $1) AS others_read_id,
            (SELECT coalesce(max(o.last_delivered_id), 0) FROM chat_members o WHERE o.chat_id = c.id AND o.user_id <> $1) AS others_delivered_id,
            (SELECT count(*)::int FROM messages x
              WHERE x.chat_id = c.id AND x.id > greatest(cm.last_read_id, cm.cleared_before_id)
                AND x.deleted_at IS NULL AND x.type <> 'system' AND x.sender_id IS DISTINCT FROM $1) AS unread,
            (SELECT count(*)::int FROM chat_members o JOIN users ou ON ou.id = o.user_id
              WHERE o.chat_id = c.id AND ou.status <> 'removed') AS member_count,
            lm.id AS last_message_id,
            peer.id AS peer_id
       FROM chat_members cm
       JOIN chats c ON c.id = cm.chat_id AND c.archived_at IS NULL
       LEFT JOIN LATERAL (
         SELECT x.id FROM messages x
          WHERE x.chat_id = c.id AND x.id > cm.cleared_before_id AND x.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = x.id AND h.user_id = $1)
          ORDER BY x.id DESC LIMIT 1) lm ON true
       LEFT JOIN LATERAL (
         SELECT o.user_id AS id FROM chat_members o WHERE o.chat_id = c.id AND o.user_id <> $1 AND c.type = 'direct' LIMIT 1
       ) peer ON true
      WHERE cm.user_id = $1 AND NOT cm.hidden AND ($2::bigint[] IS NULL OR c.id = ANY($2::bigint[]))`,
    [userId, chatIds],
  );
  if (!rows.length) return [];

  const lastIds = rows.map((r) => r.last_message_id).filter(Boolean);
  const peerIds = rows.map((r) => r.peer_id).filter(Boolean);
  const [msgs, peers] = await Promise.all([
    lastIds.length ? query(`${MESSAGE_SELECT} WHERE m.id = ANY($1::bigint[])`, [lastIds]) : { rows: [] },
    peerIds.length ? query('SELECT * FROM users WHERE id = ANY($1::bigint[])', [peerIds]) : { rows: [] },
  ]);
  const msgById = new Map(msgs.rows.map((m) => [m.id, serializeMessage(m)]));
  const peerById = new Map(peers.rows.map((u) => [u.id, publicUser(u)]));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.type === 'direct' ? peerById.get(r.peer_id)?.displayName || 'Deleted account' : r.title,
    description: r.description,
    avatarColor: r.type === 'direct' ? peerById.get(r.peer_id)?.avatarColor ?? 0 : r.avatar_color,
    avatarUrl: r.type === 'direct' ? peerById.get(r.peer_id)?.avatarUrl ?? null : null,
    peer: r.peer_id ? peerById.get(r.peer_id) || null : null,
    myRole: r.my_role,
    onlyAdminsPost: r.only_admins_post,
    membersCanAdd: r.members_can_add,
    memberCount: r.member_count,
    lastReadId: r.last_read_id,
    othersReadId: r.others_read_id,
    othersDeliveredId: r.others_delivered_id,
    unread: r.unread,
    muted: r.muted,
    pinned: r.pinned,
    archived: r.archived,
    autoTranslate: r.auto_translate,
    lastMessage: msgById.get(r.last_message_id) || null,
    createdAt: r.created_at,
  }));
}

/** Pushes a fresh chat summary to each user (their own unread counts etc. differ per user). */
export async function pushChatSummaries(chatId, userIds = null) {
  const ids = userIds || (await chatMemberIds(chatId));
  await Promise.all(
    ids.map(async (uid) => {
      const [summary] = await getChatSummaries(uid, [chatId]);
      if (summary) toUsers([uid], 'chat:updated', summary);
    }),
  );
}

export async function getChatDetails(chatId, userId) {
  const chat = await requireMember(chatId, userId);
  const [summary] = await getChatSummaries(userId, [chatId]);
  const members = await query(
    `SELECT u.*, cm.role AS member_role FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = $1 AND u.status <> 'removed'
      ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`,
    [chatId],
  );
  return {
    ...summary,
    myRole: chat.my_role,
    members: members.rows.map((u) => ({ ...publicUser(u), memberRole: u.member_role })),
  };
}

// ---------------------------------------------------------------------------
// Creating chats
// ---------------------------------------------------------------------------

export async function getOrCreateDirect(user, peerId) {
  if (peerId === user.id) throw new HttpError(400, 'You cannot start a chat with yourself.', 'VALIDATION');
  const key = `${Math.min(user.id, peerId)}:${Math.max(user.id, peerId)}`;
  const existing = await query('SELECT id FROM chats WHERE direct_key = $1', [key]);
  if (existing.rows[0]) {
    const chatId = existing.rows[0].id;
    // Opening a chat again brings it back if this person had deleted it from their list.
    const member = await query('UPDATE chat_members SET hidden = FALSE WHERE chat_id = $1 AND user_id = $2', [chatId, user.id]);
    if (member.rowCount) return { chatId, created: false };
  }
  if (user.role !== 'admin' && !user.can_start_direct) {
    throw new HttpError(403, 'You are not allowed to start new private chats.', 'FORBIDDEN');
  }
  const peer = await query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [peerId]);
  if (!peer.rows[0]) throw new HttpError(404, 'User not found.', 'NOT_FOUND');

  const chatId = await tx(async (db) => {
    const ins = await db.query(
      `INSERT INTO chats (type, direct_key, created_by) VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key RETURNING id`,
      [key, user.id],
    );
    const id = ins.rows[0].id;
    await db.query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')
       ON CONFLICT DO NOTHING`,
      [id, user.id, peerId],
    );
    return id;
  });
  return { chatId, created: true };
}

/**
 * "Delete chat for me": clears a private chat and removes it from this person's list only.
 * It comes back with just the new messages if the other person writes again.
 */
export async function hideChat(chatId, userId) {
  const chat = await requireMember(chatId, userId);
  if (chat.type !== 'direct') throw new HttpError(400, 'Only private chats can be deleted. Leave the group instead.', 'VALIDATION');
  await query(
    `UPDATE chat_members SET hidden = TRUE, pinned = FALSE, archived = FALSE,
            cleared_before_id = (SELECT coalesce(max(id), 0) FROM messages WHERE chat_id = $1)
      WHERE chat_id = $1 AND user_id = $2`,
    [chatId, userId],
  );
  toUsers([userId], 'chat:removed', { chatId });
}

/** New activity brings a deleted private chat back for whoever hid it. */
export async function revealChat(chatId) {
  await query('UPDATE chat_members SET hidden = FALSE WHERE chat_id = $1 AND hidden', [chatId]);
}

export async function createGroup(actor, { title, description = '', memberIds = [], includeSelf = true, onlyAdminsPost = false, membersCanAdd = false }) {
  if (actor.role !== 'admin' && !actor.can_create_groups) {
    throw new HttpError(403, 'You are not allowed to create groups.', 'FORBIDDEN');
  }
  const ids = [...new Set(memberIds.filter((id) => !includeSelf || id !== actor.id))];
  const valid = ids.length
    ? (await query(`SELECT id FROM users WHERE id = ANY($1::bigint[]) AND status = 'active'`, [ids])).rows.map((r) => r.id)
    : [];
  const chatId = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO chats (type, title, description, only_admins_post, members_can_add, avatar_color, created_by)
       VALUES ('group', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, description, onlyAdminsPost, membersCanAdd, randomColor(), actor.id],
    );
    const id = rows[0].id;
    if (includeSelf) await db.query(`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, actor.id]);
    for (const uid of valid) {
      await db.query(`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')`, [id, uid]);
    }
    await insertSystemMessage(db, id, actor.id, 'group_created', { title });
    return id;
  });
  await pushChatSummaries(chatId);
  return chatId;
}

async function insertSystemMessage(db, chatId, actorId, event, data = {}) {
  const { rows } = await db.query(
    `INSERT INTO messages (chat_id, sender_id, type, body, meta) VALUES ($1, $2, 'system', '', $3) RETURNING id`,
    [chatId, actorId, { event, ...data }],
  );
  return rows[0].id;
}

export async function postSystemMessage(chatId, actorId, event, data) {
  const id = await insertSystemMessage({ query }, chatId, actorId, event, data);
  const msg = await getMessage(id);
  await toChat(chatId, 'message:new', msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Group management (used by both group admins and global administrators)
// ---------------------------------------------------------------------------

/** Loads a group the actor may manage. Global admins can manage any group without being a member. */
export async function requireGroupManager(chatId, actor, { allowMemberAdd = false } = {}) {
  const { rows } = await query(
    `SELECT c.*, cm.role AS my_role FROM chats c
       LEFT JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
      WHERE c.id = $1 AND c.type = 'group' AND c.archived_at IS NULL`,
    [chatId, actor.id],
  );
  const chat = rows[0];
  if (!chat || (!chat.my_role && actor.role !== 'admin')) throw new HttpError(404, 'Group not found.', 'NOT_FOUND');
  const ok = actor.role === 'admin' || isChatAdmin(chat) || (allowMemberAdd && chat.members_can_add && chat.my_role);
  if (!ok) throw new HttpError(403, 'Only group admins can do that.', 'FORBIDDEN');
  return chat;
}

export async function updateGroup(chatId, actor, patch) {
  await requireGroupManager(chatId, actor);
  const map = { title: 'title', description: 'description', onlyAdminsPost: 'only_admins_post', membersCanAdd: 'members_can_add' };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      vals.push(patch[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return;
  vals.push(chatId);
  await query(`UPDATE chats SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (patch.title !== undefined) await postSystemMessage(chatId, actor.id, 'group_renamed', { title: patch.title });
  await pushChatSummaries(chatId);
}

export async function addGroupMembers(chatId, actor, userIds) {
  await requireGroupManager(chatId, actor, { allowMemberAdd: true });
  const { rows } = await query(
    `INSERT INTO chat_members (chat_id, user_id, role, last_delivered_id, last_read_id)
     SELECT $1, u.id, 'member', 0, 0 FROM users u WHERE u.id = ANY($2::bigint[]) AND u.status = 'active'
     ON CONFLICT DO NOTHING RETURNING user_id`,
    [chatId, userIds],
  );
  const added = rows.map((r) => r.user_id);
  if (added.length) {
    await postSystemMessage(chatId, actor.id, 'members_added', { userIds: added });
    await pushChatSummaries(chatId);
  }
  return added;
}

export async function removeGroupMember(chatId, actor, userId) {
  const self = userId === actor.id;
  let chat;
  if (self) {
    chat = await requireMember(chatId, actor.id);
    if (chat.type !== 'group') throw new HttpError(400, 'You can only leave groups.', 'VALIDATION');
  } else {
    chat = await requireGroupManager(chatId, actor);
  }
  const target = await query('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  if (!target.rows[0]) throw new HttpError(404, 'Member not found.', 'NOT_FOUND');
  if (!self && target.rows[0].role === 'owner' && actor.role !== 'admin') {
    throw new HttpError(403, 'The group owner cannot be removed.', 'FORBIDDEN');
  }
  await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  // If the owner left, promote the longest-standing admin (or member) so the group stays manageable.
  if (target.rows[0].role === 'owner') {
    await query(
      `UPDATE chat_members SET role = 'owner' WHERE (chat_id, user_id) = (
         SELECT chat_id, user_id FROM chat_members WHERE chat_id = $1
          ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1)`,
      [chatId],
    );
  }
  toUsers([userId], 'chat:removed', { chatId });
  await postSystemMessage(chatId, actor.id, self ? 'member_left' : 'member_removed', { userId });
  await pushChatSummaries(chatId);
}

export async function setMemberRole(chatId, actor, userId, role) {
  const chat = await requireGroupManager(chatId, actor);
  if (actor.role !== 'admin' && chat.my_role !== 'owner') throw new HttpError(403, 'Only the group owner can change roles.', 'FORBIDDEN');
  const { rowCount } = await query(
    `UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [chatId, userId, role],
  );
  if (!rowCount) throw new HttpError(404, 'Member not found.', 'NOT_FOUND');
  await pushChatSummaries(chatId, [userId]);
  await toChat(chatId, 'chat:members-changed', { chatId });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const VISIBLE = `m.deleted_at IS NULL AND m.id > cm.cleared_before_id
  AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = cm.user_id)`;

export async function listMessages(chatId, userId, { before, after, around, limit = 50 }) {
  await requireMember(chatId, userId);
  const base = `${MESSAGE_SELECT}
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
   WHERE m.chat_id = $1 AND ${VISIBLE}`;
  let rows;
  if (around) {
    const older = await query(`${base} AND m.id <= $3 ORDER BY m.id DESC LIMIT $4`, [chatId, userId, around, Math.ceil(limit / 2)]);
    const newer = await query(`${base} AND m.id > $3 ORDER BY m.id ASC LIMIT $4`, [chatId, userId, around, Math.floor(limit / 2)]);
    rows = [...older.rows.reverse(), ...newer.rows];
  } else if (after) {
    rows = (await query(`${base} AND m.id > $3 ORDER BY m.id ASC LIMIT $4`, [chatId, userId, after, limit])).rows;
  } else {
    const r = await query(`${base} AND ($3::bigint IS NULL OR m.id < $3) ORDER BY m.id DESC LIMIT $4`, [chatId, userId, before || null, limit]);
    rows = r.rows.reverse();
  }
  return rows.map(serializeMessage);
}

export async function assertVisibleMessage(messageId, userId) {
  const { rows } = await query(
    `SELECT m.*, c.type AS chat_type, c.only_admins_post, cm.role AS my_role
       FROM messages m
       JOIN chats c ON c.id = m.chat_id AND c.archived_at IS NULL
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
      WHERE m.id = $1 AND ${VISIBLE}`,
    [messageId, userId],
  );
  if (!rows[0]) throw new HttpError(404, 'Message not found.', 'NOT_FOUND');
  return rows[0];
}

/**
 * Creates a message. Idempotent on (sender, clientId), so clients can safely retry after reconnects.
 */
export async function sendMessage(user, chatId, { body = '', fileId = null, replyToId = null, clientId = null, type: requestedType = null }) {
  const chat = await requireMember(chatId, user.id);
  assertCanPost(chat);
  await assertDirectPeerActive(chat, user.id);

  if (clientId) {
    const dup = await query('SELECT id FROM messages WHERE sender_id = $1 AND client_id = $2', [user.id, clientId]);
    if (dup.rows[0]) return { message: await getMessage(dup.rows[0].id), duplicate: true };
  }

  let type = 'text';
  if (fileId) {
    const f = await query('SELECT kind FROM files WHERE id = $1 AND chat_id = $2 AND uploader_id = $3', [fileId, chatId, user.id]);
    if (!f.rows[0]) throw new HttpError(400, 'Attachment not found.', 'VALIDATION');
    type = f.rows[0].kind === 'voice' || requestedType === 'voice' ? 'voice' : 'file';
  } else if (!body.trim()) {
    throw new HttpError(400, 'Message is empty.', 'VALIDATION');
  }
  if (replyToId) {
    const r = await query('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [replyToId, chatId]);
    if (!r.rows[0]) throw new HttpError(400, 'The message you replied to does not exist.', 'VALIDATION');
  }

  const ins = await query(
    `INSERT INTO messages (chat_id, sender_id, client_id, type, body, file_id, reply_to_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [chatId, user.id, clientId, type, body, fileId, replyToId],
  );
  if (!ins.rows[0]) {
    const dup = await query('SELECT id FROM messages WHERE sender_id = $1 AND client_id = $2', [user.id, clientId]);
    return { message: await getMessage(dup.rows[0].id), duplicate: true };
  }
  const id = ins.rows[0].id;
  await query(
    `UPDATE chat_members SET last_read_id = greatest(last_read_id, $3), last_delivered_id = greatest(last_delivered_id, $3)
      WHERE chat_id = $1 AND user_id = $2`,
    [chatId, user.id, id],
  );
  // Unarchive the chat for everyone when new activity arrives (Telegram behaviour for non-muted chats).
  // New activity unarchives the chat (unless muted) and brings it back for anyone who deleted it.
  await query(
    `UPDATE chat_members SET archived = archived AND muted, hidden = FALSE
      WHERE chat_id = $1 AND ((archived AND NOT muted) OR hidden)`,
    [chatId],
  );
  const message = await getMessage(id);
  await toChat(chatId, 'message:new', message);
  notifyNewMessage(chat, user, message).catch((err) => console.error('[push]', err.message));
  return { message, duplicate: false };
}

/** Keeps the text copied into "X pinned ..." notices in step with the message (null removes it). */
async function syncPinNotices(chatId, messageId, preview) {
  const { rows } = await query(
    `UPDATE messages
        SET meta = CASE WHEN $3::text IS NULL THEN meta - 'preview' ELSE jsonb_set(meta, '{preview}', to_jsonb($3::text)) END
      WHERE chat_id = $1 AND type = 'system' AND meta->>'event' = 'message_pinned' AND meta->>'messageId' = $2
      RETURNING id`,
    [chatId, String(messageId), preview],
  );
  for (const { id } of rows) await toChat(chatId, 'message:updated', await getMessage(id));
}

export async function editMessage(user, messageId, body) {
  const m = await assertVisibleMessage(messageId, user.id);
  if (m.sender_id !== user.id) throw new HttpError(403, 'You can only edit your own messages.', 'FORBIDDEN');
  if (!['text', 'file'].includes(m.type)) throw new HttpError(400, 'This message cannot be edited.', 'VALIDATION');
  if (m.type === 'text' && !body.trim()) throw new HttpError(400, 'Message is empty.', 'VALIDATION');
  await query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1', [messageId, body]);
  await query('DELETE FROM message_translations WHERE message_id = $1', [messageId]);
  await syncPinNotices(m.chat_id, messageId, body.slice(0, 80));
  const message = await getMessage(messageId);
  await toChat(m.chat_id, 'message:updated', message);
  return message;
}

export async function deleteMessage(user, messageId, forEveryone) {
  const m = await assertVisibleMessage(messageId, user.id);
  if (!forEveryone) {
    await query('INSERT INTO message_hidden (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, user.id]);
    toUsers([user.id], 'message:deleted', { chatId: m.chat_id, messageId });
    toUsers([user.id], 'chat:pins', { chatId: m.chat_id });
    return;
  }
  const canModerate = m.chat_type === 'group' && ['owner', 'admin'].includes(m.my_role);
  if (m.sender_id !== user.id && !canModerate) throw new HttpError(403, 'You can only delete your own messages for everyone.', 'FORBIDDEN');
  if (m.type === 'system') throw new HttpError(400, 'System messages cannot be deleted.', 'VALIDATION');
  await query('UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [messageId, user.id]);
  await query('DELETE FROM pinned_messages WHERE message_id = $1', [messageId]);
  await syncPinNotices(m.chat_id, messageId, null);
  await toChat(m.chat_id, 'message:deleted', { chatId: m.chat_id, messageId });
}

export async function toggleReaction(user, messageId, emoji) {
  const m = await assertVisibleMessage(messageId, user.id);
  const del = await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, user.id, emoji]);
  if (!del.rowCount) {
    // One reaction per user per message, like Telegram's default.
    await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [messageId, user.id]);
    await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, user.id, emoji]);
  }
  const message = await getMessage(messageId);
  await toChat(m.chat_id, 'message:reactions', { chatId: m.chat_id, messageId, reactions: message.reactions });
  return message.reactions;
}

export async function forwardMessages(user, messageIds, toChatIds) {
  const sources = [];
  for (const id of messageIds) {
    const m = await assertVisibleMessage(id, user.id);
    if (m.type === 'system' || m.type === 'call') continue;
    const sender = m.forwarded_from_id || m.forwarded_name
      ? { id: m.forwarded_from_id, name: m.forwarded_name }
      : (await query('SELECT id, display_name AS name FROM users WHERE id = $1', [m.sender_id])).rows[0];
    sources.push({ m, sender });
  }
  sources.sort((a, b) => a.m.id - b.m.id);
  const created = [];
  for (const chatId of toChatIds) {
    const chat = await requireMember(chatId, user.id);
    assertCanPost(chat);
    await assertDirectPeerActive(chat, user.id);
    await revealChat(chatId);
    for (const { m, sender } of sources) {
      const { rows } = await query(
        `INSERT INTO messages (chat_id, sender_id, type, body, file_id, forwarded_from_id, forwarded_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [chatId, user.id, m.type, m.body, m.file_id, sender?.id || null, sender?.name || 'Unknown'],
      );
      const message = await getMessage(rows[0].id);
      await query(
        `UPDATE chat_members SET last_read_id = greatest(last_read_id, $3), last_delivered_id = greatest(last_delivered_id, $3)
          WHERE chat_id = $1 AND user_id = $2`,
        [chatId, user.id, message.id],
      );
      await toChat(chatId, 'message:new', message);
      notifyNewMessage(chat, user, message).catch(() => {});
      created.push(message);
    }
  }
  return created;
}

export async function setPinned(user, messageId, pinned) {
  const m = await assertVisibleMessage(messageId, user.id);
  if (m.chat_type === 'group' && !['owner', 'admin'].includes(m.my_role) && !(user.role === 'admin')) {
    throw new HttpError(403, 'Only group admins can pin messages.', 'FORBIDDEN');
  }
  if (pinned) {
    const r = await query(
      'INSERT INTO pinned_messages (chat_id, message_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [m.chat_id, messageId, user.id],
    );
    if (r.rowCount) await postSystemMessage(m.chat_id, user.id, 'message_pinned', { messageId, preview: m.body.slice(0, 80) });
  } else {
    await query('DELETE FROM pinned_messages WHERE chat_id = $1 AND message_id = $2', [m.chat_id, messageId]);
  }
  await toChat(m.chat_id, 'chat:pins', { chatId: m.chat_id });
}

/** "Seen by": for the sender of a group message, who has read it and when. */
export async function messageReads(messageId, userId) {
  const m = await assertVisibleMessage(messageId, userId);
  if (m.sender_id !== userId) throw new HttpError(403, 'Only the sender can see who read a message.', 'FORBIDDEN');
  const { rows } = await query(
    `SELECT u.*, cm.last_read_id >= $2 AS has_read,
            (SELECT min(r.read_at) FROM message_reads r
              WHERE r.chat_id = cm.chat_id AND r.user_id = cm.user_id AND r.up_to_id >= $2) AS read_at
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = $1 AND cm.user_id <> $3 AND u.status <> 'removed'`,
    [m.chat_id, messageId, userId],
  );
  const read = rows.filter((r) => r.has_read)
    .map((r) => ({ user: publicUser(r), readAt: r.read_at }))
    .sort((a, b) => new Date(b.readAt || 0) - new Date(a.readAt || 0));
  const unread = rows.filter((r) => !r.has_read).map((r) => publicUser(r));
  return { read, unread };
}

export async function listPins(chatId, userId) {
  await requireMember(chatId, userId);
  const { rows } = await query(
    `${MESSAGE_SELECT} JOIN pinned_messages p ON p.message_id = m.id
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
      WHERE p.chat_id = $1 AND ${VISIBLE} ORDER BY p.pinned_at DESC`,
    [chatId, userId],
  );
  return rows.map(serializeMessage);
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** Advances the user's delivered/read cursors (never backwards) and tells the chat. */
export async function markReceipt(userId, chatId, { readId = 0, deliveredId = 0 }) {
  const upTo = Math.max(readId, deliveredId);
  const { rows } = await query(
    `WITH before AS (SELECT last_read_id FROM chat_members WHERE chat_id = $1 AND user_id = $2)
     UPDATE chat_members cm
        SET last_read_id = greatest(cm.last_read_id, least($3::bigint, (SELECT coalesce(max(id), 0) FROM messages WHERE chat_id = $1))),
            last_delivered_id = greatest(cm.last_delivered_id, least($4::bigint, (SELECT coalesce(max(id), 0) FROM messages WHERE chat_id = $1)))
      WHERE cm.chat_id = $1 AND cm.user_id = $2
        AND (cm.last_read_id < $3 OR cm.last_delivered_id < $4)
      RETURNING last_read_id, last_delivered_id, (SELECT last_read_id FROM before) AS read_before`,
    [chatId, userId, readId, upTo],
  );
  if (!rows[0]) return null;
  if (rows[0].last_read_id > rows[0].read_before) {
    await query(
      'INSERT INTO message_reads (chat_id, user_id, up_to_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [chatId, userId, rows[0].last_read_id],
    );
  }
  const receipt = { chatId, userId, readId: rows[0].last_read_id, deliveredId: rows[0].last_delivered_id };
  await toChat(chatId, 'receipt', receipt);
  return receipt;
}

/** On (re)connect, everything currently in the user's chats counts as delivered. */
export async function markAllDelivered(userId) {
  const { rows } = await query(
    `UPDATE chat_members cm SET last_delivered_id = x.max_id
       FROM (SELECT chat_id, max(id) AS max_id FROM messages GROUP BY chat_id) x
      WHERE cm.user_id = $1 AND x.chat_id = cm.chat_id AND cm.last_delivered_id < x.max_id
      RETURNING cm.chat_id, cm.last_read_id, cm.last_delivered_id`,
    [userId],
  );
  for (const r of rows) {
    await toChat(r.chat_id, 'receipt', { chatId: r.chat_id, userId, readId: r.last_read_id, deliveredId: r.last_delivered_id });
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchMessages(userId, q, chatId = null, limit = 50) {
  const { rows } = await query(
    `${MESSAGE_SELECT}
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
       JOIN chats c ON c.id = m.chat_id AND c.archived_at IS NULL
      WHERE ${VISIBLE} AND m.type IN ('text', 'file')
        AND ($3::bigint IS NULL OR m.chat_id = $3)
        AND (m.body ILIKE $2 OR f.file_name ILIKE $2)
      ORDER BY m.id DESC LIMIT $4`,
    [userId, `%${likeEscape(q)}%`, chatId, limit],
  );
  return rows.map(serializeMessage);
}
