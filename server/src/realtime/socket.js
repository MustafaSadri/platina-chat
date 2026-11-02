import { Server } from 'socket.io';
import { config } from '../config.js';
import { query } from '../db.js';
import { allowedOrigins, readSessionToken } from '../middleware.js';
import { getSessionUser, publicUser } from '../services/auth.js';
import { markAllDelivered, markReceipt } from '../services/chats.js';
import { broadcast, sessionRoom, setIo, userRoom } from './bus.js';
import { registerCallHandlers } from './calls.js';

/** Simple per-socket token bucket so a misbehaving client can't flood the server. */
function rateLimiter(perSecond, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

async function isMember(chatId, userId) {
  const { rows } = await query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  return rows.length > 0;
}

export async function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: config.extraOrigins.length ? { origin: [...allowedOrigins()], credentials: true } : undefined,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 256 * 1024,
  });

  if (config.redisUrl) {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const { createClient } = await import('redis');
    const pub = createClient({ url: config.redisUrl });
    const sub = pub.duplicate();
    pub.on('error', (e) => console.error('[redis]', e.message));
    sub.on('error', (e) => console.error('[redis]', e.message));
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    console.log('[socket] Redis adapter enabled');
  }

  // Authenticate with the same httpOnly session cookie as the REST API.
  io.use(async (socket, next) => {
    try {
      const origin = socket.handshake.headers.origin;
      if (origin && origin !== config.appUrl && !allowedOrigins().has(origin)) {
        const host = socket.handshake.headers.host;
        if (!host || !origin.endsWith(`//${host}`)) return next(new Error('BAD_ORIGIN'));
      }
      const user = await getSessionUser(readSessionToken(socket.handshake.headers.cookie));
      if (!user) return next(new Error('UNAUTHENTICATED'));
      if (user.must_change_password) return next(new Error('PASSWORD_CHANGE_REQUIRED'));
      socket.data.userId = user.id;
      socket.data.sessionId = user.session_id;
      socket.data.user = publicUser(user);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Async socket handlers must never leak rejections (e.g. a DB blip) into the process.
  const safe = (name, fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[socket] ${name} failed:`, err.message);
    }
  };

  io.on('connection', (socket) => {
    const { userId, sessionId } = socket.data;
    socket.join([userRoom(userId), sessionRoom(sessionId)]);

    const typingLimit = rateLimiter(2, 5);
    const receiptLimit = rateLimiter(20, 40);

    // Handlers are registered synchronously so events sent right after connecting aren't lost.
    socket.on('typing', safe('typing', async (payload) => {
      const chatId = Number(payload?.chatId);
      if (!Number.isInteger(chatId) || !typingLimit()) return;
      if (!(await isMember(chatId, userId))) return;
      const kind = payload?.kind === 'voice' ? 'voice' : 'text';
      const { rows } = await query('SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2', [chatId, userId]);
      if (rows.length) io.to(rows.map((r) => userRoom(r.user_id))).emit('typing', { chatId, userId, kind });
    }));

    // Client confirms receipt of messages pushed over the socket.
    socket.on('delivered', safe('delivered', async (payload) => {
      const chatId = Number(payload?.chatId);
      const messageId = Number(payload?.messageId);
      if (!Number.isInteger(chatId) || !Number.isInteger(messageId) || !receiptLimit()) return;
      await markReceipt(userId, chatId, { deliveredId: messageId });
    }));

    registerCallHandlers(io, socket, rateLimiter(50, 200));

    socket.on('disconnect', safe('disconnect', async () => {
      const stillOnline = (await io.in(userRoom(userId)).fetchSockets()).length > 0;
      if (stillOnline) return;
      const { rows } = await query('UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at', [userId]);
      broadcast('presence', { userId, online: false, lastSeenAt: rows[0]?.last_seen_at });
    }));

    safe('connect', async () => {
      const wasOnline = (await io.in(userRoom(userId)).fetchSockets()).length > 1;
      if (!wasOnline) broadcast('presence', { userId, online: true });
      await markAllDelivered(userId);
    })();
  });

  setIo(io);
  return io;
}
