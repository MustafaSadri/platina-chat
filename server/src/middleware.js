import * as cookie from 'cookie';
import { config } from './config.js';
import { getSessionUser } from './services/auth.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function readSessionToken(cookieHeader) {
  if (!cookieHeader) return null;
  return cookie.parse(cookieHeader)[config.cookieName] || null;
}

export const allowedOrigins = () => new Set([config.appUrl, ...config.extraOrigins]);

/** CSRF defence: state-changing requests must come from our own origin. */
export function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) {
    // Non-browser clients (curl, tests) send no Origin; browsers always do for cross-site POSTs.
    return next();
  }
  const self = `${req.protocol}://${req.get('host')}`;
  if (origin === self || allowedOrigins().has(origin)) return next();
  return next(new HttpError(403, 'Cross-origin request blocked.', 'BAD_ORIGIN'));
}

export const loadUser = asyncH(async (req, res, next) => {
  const token = readSessionToken(req.headers.cookie);
  req.user = token ? await getSessionUser(token) : null;
  next();
});

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Not signed in.', 'UNAUTHENTICATED'));
  next();
}

/** Users with a temporary password may only change it (and read their own profile / sign out). */
export function requirePasswordChanged(req, res, next) {
  if (req.user?.must_change_password) {
    return next(new HttpError(403, 'You must change your temporary password first.', 'PASSWORD_CHANGE_REQUIRED'));
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(new HttpError(403, 'Administrator access required.', 'FORBIDDEN'));
  next();
}

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'input'}: ${first.message}`, 'VALIDATION');
  }
  return r.data;
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message, code: err.code });
}
