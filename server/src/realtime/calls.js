import crypto from 'node:crypto';
import { query } from '../db.js';
import { userRoom } from './bus.js';
import { getMessage } from '../services/chats.js';
import { toChat } from './bus.js';
import { sendToUser } from '../services/push.js';

// Active 1:1 calls. State is per server instance (see docs/ARCHITECTURE.md for scaling notes).
const calls = new Map();
const RING_TIMEOUT_MS = 45_000;

async function recordCall(call, status) {
  const durationSec = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;
  const { rows } = await query(
    `INSERT INTO messages (chat_id, sender_id, type, body, meta) VALUES ($1, $2, 'call', '', $3) RETURNING id`,
    [call.chatId, call.callerId, { video: call.video, status, durationSec }],
  );
  const msg = await getMessage(rows[0].id);
  await toChat(call.chatId, 'message:new', msg);
}

function finish(io, callId, status, reason) {
  const call = calls.get(callId);
  if (!call) return;
  calls.delete(callId);
  clearTimeout(call.timer);
  const payload = { callId, reason };
  io.to([userRoom(call.callerId), userRoom(call.calleeId)]).emit('call:ended', payload);
  recordCall(call, status).catch((err) => console.error('[calls] record failed', err.message));
}

const isParty = (call, userId) => call && (call.callerId === userId || call.calleeId === userId);

export function registerCallHandlers(io, socket, limit) {
  const { userId } = socket.data;

  socket.on('call:invite', async (payload, ack = () => {}) => {
    try {
      const chatId = Number(payload?.chatId);
      const video = !!payload?.video;
      const { rows } = await query(
        `SELECT o.user_id AS peer_id, u.status FROM chats c
           JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
           JOIN chat_members o ON o.chat_id = c.id AND o.user_id <> $2
           JOIN users u ON u.id = o.user_id
          WHERE c.id = $1 AND c.type = 'direct' AND c.archived_at IS NULL`,
        [chatId, userId],
      );
      const peer = rows[0];
      if (!peer || peer.status !== 'active') return ack({ error: 'Calls are only available in private chats with active users.' });
      for (const c of calls.values()) {
        if (isParty(c, peer.peer_id)) return ack({ error: 'busy' });
        if (isParty(c, userId)) return ack({ error: 'You are already in a call.' });
      }
      const callId = crypto.randomUUID();
      const call = {
        callId, chatId, video, callerId: userId, calleeId: peer.peer_id,
        callerSocket: socket.id, calleeSocket: null, answeredAt: null,
      };
      calls.set(callId, call);
      call.timer = setTimeout(() => finish(io, callId, 'missed', 'no-answer'), RING_TIMEOUT_MS);
      const online = (await io.in(userRoom(peer.peer_id)).fetchSockets()).length > 0;
      io.to(userRoom(peer.peer_id)).emit('call:incoming', { callId, chatId, video, from: socket.data.user });
      if (!online) {
        sendToUser(peer.peer_id, {
          title: socket.data.user.displayName,
          body: video ? '📹 Incoming video call' : '📞 Incoming call',
          chatId, tag: `call-${callId}`,
        }).catch(() => {});
      }
      ack({ callId });
    } catch (err) {
      console.error('[calls] invite', err);
      ack({ error: 'Could not start the call.' });
    }
  });

  socket.on('call:accept', (payload, ack = () => {}) => {
    const call = calls.get(payload?.callId);
    if (!call || call.calleeId !== userId || call.answeredAt) return ack({ error: 'Call is no longer available.' });
    call.answeredAt = Date.now();
    call.calleeSocket = socket.id;
    clearTimeout(call.timer);
    io.to(call.callerSocket).emit('call:accepted', { callId: call.callId });
    // Stop ringing on the callee's other devices.
    socket.to(userRoom(userId)).emit('call:ended', { callId: call.callId, reason: 'answered-elsewhere' });
    ack({ ok: true });
  });

  socket.on('call:reject', (payload) => {
    const call = calls.get(payload?.callId);
    if (call && call.calleeId === userId && !call.answeredAt) finish(io, call.callId, 'declined', 'declined');
  });

  socket.on('call:end', (payload) => {
    const call = calls.get(payload?.callId);
    if (!isParty(call, userId)) return;
    finish(io, call.callId, call.answeredAt ? 'completed' : 'cancelled', 'hangup');
  });

  // Relays SDP offers/answers and ICE candidates between the two connected sockets only.
  socket.on('call:signal', (payload) => {
    if (!limit()) return;
    const call = calls.get(payload?.callId);
    if (!call || !call.answeredAt) return;
    let target = null;
    if (socket.id === call.callerSocket) target = call.calleeSocket;
    else if (socket.id === call.calleeSocket) target = call.callerSocket;
    if (!target) return;
    io.to(target).emit('call:signal', { callId: call.callId, data: payload.data });
  });

  socket.on('disconnect', () => {
    for (const call of calls.values()) {
      if (call.callerSocket === socket.id || call.calleeSocket === socket.id) {
        finish(io, call.callId, call.answeredAt ? 'completed' : 'cancelled', 'disconnected');
      }
    }
  });
}
