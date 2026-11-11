import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { query } from '../db.js';

const BCRYPT_COST = 12;
// Constant-time-ish login for unknown usernames: compare against a real hash.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash || DUMMY_HASH);

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

/** Readable temporary password: 4 groups of 4 from an unambiguous alphabet, plus digits guaranteed. */
export function generateTempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return /[0-9]/.test(out) ? out : `${out.slice(0, -1)}7`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await query(
    'INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [userId, sha256(token), userAgent.slice(0, 300), ip, expires],
  );
  return { token, expires };
}

/**
 * Resolves a session token to an *active* user. Checked on every request and socket connection,
 * so deactivating or removing a user takes effect immediately.
 */
const TOUCH_EVERY_MS = 5 * 60_000;

export async function getSessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_used_at AS session_used_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  const user = rows[0];
  if (!user) return null;
  // "Last active" for the sessions list only needs minute-level accuracy: write at most every 5 minutes.
  if (Date.now() - new Date(user.session_used_at).getTime() > TOUCH_EVERY_MS) {
    query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [user.session_id]).catch(() => {});
  }
  return user;
}

export const deleteSession = (token) => query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
export const deleteUserSessions = (userId, exceptSessionId = 0) =>
  query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, exceptSessionId]);

export function sessionCookieOptions(expires) {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    expires,
  };
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    title: u.title,
    role: u.role,
    status: u.status,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_key ? `/api/users/${u.id}/avatar?v=${u.avatar_key.slice(-10)}` : null,
    lastSeenAt: u.last_seen_at,
  };
}

export function selfUser(u) {
  return {
    ...publicUser(u),
    mustChangePassword: u.must_change_password,
    language: u.language,
    canCreateGroups: u.role === 'admin' || u.can_create_groups,
    canStartDirect: u.role === 'admin' || u.can_start_direct,
  };
}
