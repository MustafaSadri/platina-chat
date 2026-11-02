import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError, asyncH, parse, readSessionToken, requireAuth } from '../middleware.js';
import {
  createSession, deleteSession, deleteUserSessions, hashPassword, selfUser,
  sessionCookieOptions, validatePasswordStrength, verifyPassword,
} from '../services/auth.js';
import { audit } from '../services/audit.js';
import { disconnectSession } from '../realtime/bus.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.rateLimit.loginPerWindow,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.username || '').toLowerCase().slice(0, 64)}`,
  message: { error: 'Too many failed sign-in attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
  validate: { keyGeneratorIpFallback: false },
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

router.post('/login', loginLimiter, asyncH(async (req, res) => {
  const { username, password } = parse(loginSchema, req.body);
  const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash);
  if (!user || !ok || user.status !== 'active') {
    if (user) audit(user.id, 'login_failed', { ip: req.ip, details: { status: user.status } });
    // Same message for every failure so usernames can't be enumerated.
    throw new HttpError(401, 'Invalid username or password.', 'BAD_CREDENTIALS');
  }
  const { token, expires } = await createSession(user.id, { userAgent: req.get('user-agent') || '', ip: req.ip });
  res.cookie(config.cookieName, token, sessionCookieOptions(expires));
  audit(user.id, 'login', { ip: req.ip });
  res.json({ user: selfUser(user) });
}));

router.post('/logout', asyncH(async (req, res) => {
  const token = readSessionToken(req.headers.cookie);
  if (token) await deleteSession(token);
  if (req.user) disconnectSession(req.user.session_id);
  res.clearCookie(config.cookieName, { ...sessionCookieOptions(), expires: undefined });
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: selfUser(req.user) }));

const changeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

router.post('/change-password', requireAuth, asyncH(async (req, res) => {
  const { currentPassword, newPassword } = parse(changeSchema, req.body);
  if (!(await verifyPassword(currentPassword, req.user.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect.', 'BAD_PASSWORD');
  }
  const weak = validatePasswordStrength(newPassword);
  if (weak) throw new HttpError(400, weak, 'WEAK_PASSWORD');
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password different from the current one.', 'WEAK_PASSWORD');
  await query(
    'UPDATE users SET password_hash = $2, must_change_password = FALSE, password_changed_at = now() WHERE id = $1',
    [req.user.id, await hashPassword(newPassword)],
  );
  // Sign out every other device.
  const others = await query('SELECT id FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.session_id]);
  await deleteUserSessions(req.user.id, req.user.session_id);
  others.rows.forEach((s) => disconnectSession(s.id));
  audit(req.user.id, 'password_changed', { ip: req.ip });
  res.json({ user: selfUser({ ...req.user, must_change_password: false }) });
}));

router.patch('/preferences', requireAuth, asyncH(async (req, res) => {
  const { language } = parse(z.object({ language: z.enum(['en', 'ru']) }), req.body);
  const { rows } = await query('UPDATE users SET language = $2 WHERE id = $1 RETURNING *', [req.user.id, language]);
  res.json({ user: selfUser(rows[0]) });
}));

router.get('/sessions', requireAuth, asyncH(async (req, res) => {
  const { rows } = await query(
    'SELECT id, user_agent, ip, created_at, last_used_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_used_at DESC',
    [req.user.id],
  );
  res.json({
    sessions: rows.map((s) => ({
      id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: s.created_at, lastUsedAt: s.last_used_at,
      current: s.id === req.user.session_id,
    })),
  });
}));

router.delete('/sessions/:id', requireAuth, asyncH(async (req, res) => {
  const id = Number(req.params.id);
  await query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  disconnectSession(id);
  res.json({ ok: true });
}));

export default router;
