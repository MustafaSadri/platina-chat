import { Router } from 'express';
import Busboy from 'busboy';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncH, HttpError, parse } from '../middleware.js';
import { publicUser, selfUser } from '../services/auth.js';
import { audit } from '../services/audit.js';
import { searchMessages } from '../services/chats.js';
import { getIceServers, turnConfigured } from '../services/ice.js';
import { pushEnabled, sendToUser } from '../services/push.js';
import { translationEnabled } from '../services/translate.js';
import { contentDisposition, storage } from '../services/storage.js';
import { broadcast, onlineUserIds, toUsers } from '../realtime/bus.js';
import { declineFromNotification } from '../realtime/calls.js';

const router = Router();

/** Company directory: active colleagues you can message. Former employees are resolved via /users/:id for history. */
router.get('/users', asyncH(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 64);
  const { rows } = await query(
    `SELECT * FROM users WHERE status = 'active' AND id <> $1
        AND ($2 = '' OR display_name ILIKE '%' || $2 || '%' OR username ILIKE '%' || $2 || '%')
      ORDER BY lower(display_name) LIMIT 500`,
    [req.user.id, q.replace(/[\\%_]/g, (c) => `\\${c}`)],
  );
  res.json({ users: rows.map(publicUser) });
}));

router.get('/users/:id', asyncH(async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(rows[0]) });
}));

// ---------------------------------------------------------------------------
// Own profile: display name and picture. The username never changes.
// ---------------------------------------------------------------------------

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const profileChanged = (user) => {
  toUsers([user.id], 'me:updated', {});
  broadcast('directory:changed', {});
};

router.patch('/profile', asyncH(async (req, res) => {
  const { displayName } = parse(z.object({ displayName: z.string().trim().min(1).max(64) }), req.body);
  const { rows } = await query('UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *', [req.user.id, displayName]);
  audit(req.user.id, 'display_name_changed', { targetType: 'user', targetId: req.user.id, details: { from: req.user.display_name, to: displayName }, ip: req.ip });
  profileChanged(rows[0]);
  res.json({ user: selfUser(rows[0]) });
}));

function readSingleFile(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes } });
    } catch {
      reject(new HttpError(400, 'Expected multipart/form-data.', 'VALIDATION'));
      return;
    }
    const chunks = [];
    let tooLarge = false;
    bb.on('file', (_name, stream) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => { tooLarge = true; });
    });
    bb.on('close', () => (tooLarge
      ? reject(new HttpError(413, 'That picture is too large.', 'TOO_LARGE'))
      : resolve(Buffer.concat(chunks))));
    bb.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new HttpError(400, 'The upload was interrupted.', 'UPLOAD_ABORTED')); });
    req.pipe(bb);
  });
}

/** The app crops and converts pictures to JPEG first, so anything else is refused here. */
router.post('/profile/avatar', asyncH(async (req, res) => {
  const image = await readSingleFile(req, MAX_AVATAR_BYTES);
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
    throw new HttpError(400, 'Please choose a JPEG picture.', 'VALIDATION');
  }
  const key = `avatars/${req.user.id}/${crypto.randomBytes(18).toString('base64url')}`;
  await storage.put(key, Readable.from(image), 'image/jpeg');
  const { rows } = await query('UPDATE users SET avatar_key = $2 WHERE id = $1 RETURNING *', [req.user.id, key]);
  if (req.user.avatar_key) await storage.remove(req.user.avatar_key).catch(() => {});
  profileChanged(rows[0]);
  res.json({ user: selfUser(rows[0]) });
}));

router.delete('/profile/avatar', asyncH(async (req, res) => {
  const { rows } = await query('UPDATE users SET avatar_key = NULL WHERE id = $1 RETURNING *', [req.user.id]);
  if (req.user.avatar_key) await storage.remove(req.user.avatar_key).catch(() => {});
  profileChanged(rows[0]);
  res.json({ user: selfUser(rows[0]) });
}));

router.get('/users/:id/avatar', asyncH(async (req, res) => {
  const { rows } = await query('SELECT avatar_key FROM users WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rows[0]?.avatar_key) throw new HttpError(404, 'No picture.', 'NOT_FOUND');
  await storage.serve(req, res, rows[0].avatar_key, { mime: 'image/jpeg', disposition: contentDisposition('inline', 'avatar.jpg') });
}));

router.get('/presence', asyncH(async (req, res) => {
  res.json({ online: await onlineUserIds() });
}));

router.get('/search', asyncH(async (req, res) => {
  const { q, chatId } = parse(z.object({
    q: z.string().trim().min(1).max(100),
    chatId: z.coerce.number().int().positive().optional(),
  }), req.query);
  res.json({ messages: await searchMessages(req.user.id, q, chatId ?? null) });
}));

router.get('/calls/ice', asyncH(async (req, res) => {
  res.json({ iceServers: await getIceServers(), turn: turnConfigured() });
}));

router.post('/calls/:id/decline', (req, res) => {
  res.json({ ok: declineFromNotification(req.params.id, req.user.id) });
});

router.get('/config', (req, res) => {
  res.json({
    vapidPublicKey: pushEnabled ? config.push.publicKey : null,
    maxUploadMb: config.storage.maxUploadMb,
    translation: translationEnabled(),
  });
});

const subSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

router.post('/push/subscribe', asyncH(async (req, res) => {
  const sub = parse(subSchema, req.body);
  await query(
    `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.user.id, req.user.session_id, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
  res.json({ ok: true });
}));

/** Lets people confirm from Settings that notifications really reach their devices. */
router.post('/push/test', asyncH(async (req, res) => {
  const body = req.user.language === 'ru' ? 'Уведомления работают.' : 'Notifications are working.';
  res.json(await sendToUser(req.user.id, { title: 'TeamChat', body, tag: `test-${Date.now()}` }));
}));

router.post('/push/unsubscribe', asyncH(async (req, res) => {
  const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
  res.json({ ok: true });
}));

export default router;
