import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncH, parse } from '../middleware.js';
import { publicUser } from '../services/auth.js';
import { searchMessages } from '../services/chats.js';
import { getIceServers, turnConfigured } from '../services/ice.js';
import { pushEnabled } from '../services/push.js';
import { translationEnabled } from '../services/translate.js';
import { onlineUserIds } from '../realtime/bus.js';

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
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
  res.json({ ok: true });
}));

router.post('/push/unsubscribe', asyncH(async (req, res) => {
  const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
  res.json({ ok: true });
}));

export default router;
