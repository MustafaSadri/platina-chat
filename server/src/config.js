import dotenv from 'dotenv';

// Tests configure their own throwaway database and must never pick up real credentials from .env.
if (process.env.NODE_ENV !== 'test') dotenv.config();

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: int(env.PORT, 3000),
  appUrl: (env.APP_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
  // Extra origins allowed to call the API (e.g. the Vite dev server). Comma separated.
  extraOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  databaseUrl: env.DATABASE_URL,
  // Neon: use the direct (non-pooled) URL for migrations when available.
  migrationDatabaseUrl: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL,
  dbSsl: bool(env.DATABASE_SSL, isProd),
  dbPoolMax: int(env.DATABASE_POOL_MAX, 10),
  sessionDays: int(env.SESSION_DAYS, 30),
  cookieName: isProd ? '__Host-tc_session' : 'tc_session',
  trustProxy: int(env.TRUST_PROXY, isProd ? 1 : 0),
  forceHttps: bool(env.FORCE_HTTPS, isProd),
  redisUrl: env.REDIS_URL || '',
  storage: {
    driver: env.STORAGE_DRIVER || (env.S3_BUCKET ? 's3' : 'local'),
    localDir: env.LOCAL_STORAGE_DIR || './data/uploads',
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    maxUploadMb: int(env.MAX_UPLOAD_MB, 100),
  },
  turn: {
    cloudflareKeyId: env.CLOUDFLARE_TURN_KEY_ID || '',
    cloudflareApiToken: env.CLOUDFLARE_TURN_API_TOKEN || '',
    urls: (env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    username: env.TURN_USERNAME || '',
    credential: env.TURN_CREDENTIAL || '',
    stunUrls: (env.STUN_URLS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
  },
  push: {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  translate: {
    // deepl | google | libretranslate | (empty = disabled)
    provider: (env.TRANSLATE_PROVIDER || '').toLowerCase(),
    deeplKey: env.DEEPL_API_KEY || '',
    googleKey: env.GOOGLE_TRANSLATE_API_KEY || '',
    libreUrl: env.LIBRETRANSLATE_URL || '',
    libreKey: env.LIBRETRANSLATE_API_KEY || '',
  },
  rateLimit: {
    loginPerWindow: int(env.LOGIN_RATE_LIMIT, 10),
    apiPerMinute: int(env.API_RATE_LIMIT, 600),
  },
};

export function assertConfig() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  if (config.isProd && config.storage.driver === 'local') {
    console.warn('[config] WARNING: STORAGE_DRIVER=local in production. Render disks are ephemeral; configure Cloudflare R2 (S3_*).');
  }
  if (config.storage.driver === 's3') {
    for (const k of ['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey']) {
      if (!config.storage[k]) throw new Error(`S3 storage selected but S3 ${k} is missing.`);
    }
  }
}
