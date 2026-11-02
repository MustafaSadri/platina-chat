import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db.js';
import {
  errorHandler, loadUser, originCheck, requireAdmin, requireAuth, requirePasswordChanged,
} from './middleware.js';
import authRoutes from './routes/auth.js';
import chatRoutes, { messagesRouter, translateRouter } from './routes/chats.js';
import fileRoutes from './routes/files.js';
import adminRoutes from './routes/admin.js';
import miscRoutes from './routes/misc.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

function storageOrigin() {
  if (config.storage.driver !== 's3' || !config.storage.endpoint) return [];
  try { return [new URL(config.storage.endpoint).origin]; } catch { return []; }
}

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  if (config.forceHttps) {
    app.use((req, res, next) => {
      if (req.secure || req.path === '/healthz') return next();
      res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    });
  }

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', ...storageOrigin()],
        'media-src': ["'self'", 'blob:', ...storageOrigin()],
        'connect-src': ["'self'", 'wss:', 'ws:'],
        'worker-src': ["'self'"],
        'frame-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'upgrade-insecure-requests': config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));
  app.use(compression());

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use(originCheck);
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(loadUser);
  api.use(rateLimit({
    windowMs: 60_000,
    limit: config.rateLimit.apiPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `u${req.user.id}` : `ip${req.ip}`),
    message: { error: 'Too many requests. Slow down a little.', code: 'RATE_LIMITED' },
    validate: { keyGeneratorIpFallback: false },
  }));

  api.use('/auth', authRoutes);
  api.use(requireAuth, requirePasswordChanged);
  api.use('/chats', chatRoutes);
  api.use('/messages', messagesRouter);
  api.use('/translate', translateRouter);
  api.use('/', fileRoutes);
  api.use('/admin', requireAdmin, adminRoutes);
  api.use('/', miscRoutes);
  api.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' }));
  app.use('/api', api);

  // Built SPA.
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      index: false,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
