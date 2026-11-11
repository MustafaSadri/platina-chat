import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { getIo, isForeground, toChat, userRoom } from './bus.js';
import { publicUser } from '../services/auth.js';
import { getMessage, revealChat } from '../services/chats.js';
import { sendToUser } from '../services/push.js';
import { declineGroupCall, isInGroupCall } from './groupCalls.js';

// Active 1:1 calls. State is per server instance (see docs/ARCHITECTURE.md for scaling notes).
const calls = new Map();
const RING_TIMEOUT_MS = 45_000;
// A web app can't ring like a phone call, so while ringing we repeat the notification instead.
const PUSH_RING_INTERVAL_MS = 7_000;
const PUSH_RING_COUNT = 6;

async function recordCall(call, status) {
  await revealChat(call.chatId);
  const endedAt = call.droppedAt || Date.now();
  const durationSec = call.answeredAt ? Math.round((endedAt - call.answeredAt) / 1000) : 0;
  const { rows } = await query(
    `INSERT INTO messages (chat_id, sender_id, type, body, meta) VALUES ($1, $2, 'call', '', $3) RETURNING id`,
    [call.chatId, call.callerId, { video: call.video, status, durationSec }],
  );
  const msg = await getMessage(rows[0].id);
  await toChat(call.chatId, 'message:new', msg);
}

const logPushError = (err) => console.error('[calls] push failed', err.message);

function ringDevices(call) {
  let count = 0;
  const send = async () => {
    count += 1;
    if (!calls.has(call.callId) || call.answeredAt || count > PUSH_RING_COUNT) {
      clearInterval(call.pushTimer);
      return;
    }
    if (await isForeground(call.calleeId)) return;
    await sendToUser(call.calleeId, {
      title: call.from.displayName,
      body: call.video ? '📹 Incoming video call' : '📞 Incoming call',
      chatId: call.chatId,
      callId: call.callId,
      type: 'call', // adds Answer and Decline buttons where the device supports them
      tag: `call-${call.callId}-${count}`, // a new tag each time, so every repeat alerts
    }, { ttl: 30 });
  };
  send().catch(logPushError);
  call.pushTimer = setInterval(() => send().catch(logPushError), PUSH_RING_INTERVAL_MS);
  call.pushTimer.unref?.();
}

async function notifyMissed(call) {
  if (await isForeground(call.calleeId)) return;
  await sendToUser(call.calleeId, {
    title: call.from.displayName,
    body: call.video ? '📹 Missed video call' : '📞 Missed call',
    chatId: call.chatId,
    tag: `missed-${call.callId}`,
    clearCalls: true,
  });
}

function finish(io, callId, status, reason) {
  const call = calls.get(callId);
  if (!call) return;
  calls.delete(callId);
  clearTimeout(call.timer);
  clearTimeout(call.graceTimer);
  clearInterval(call.pushTimer);
  if (status === 'missed' || status === 'cancelled') notifyMissed(call).catch(logPushError);
  const payload = { callId, reason };
  io.to([userRoom(call.callerId), userRoom(call.calleeId)]).emit('call:ended', payload);
  recordCall(call, status).catch((err) => console.error('[calls] record failed', err.message));
}

const isParty = (call, userId) => call && (call.callerId === userId || call.calleeId === userId);

export const isInDirectCall = (userId) => [...calls.values()].some((c) => isParty(c, userId));

/** The notification's Decline button. Returns false for calls that are already over. */
export function declineFromNotification(callId, userId) {
  const call = calls.get(callId);
  if (!call) return declineGroupCall(callId, userId);
  if (call.calleeId === userId && !call.answeredAt) finish(getIo(), callId, 'declined', 'declined');
  return true;
}

export function registerCallHandlers(io, socket, limit) {
  const { userId } = socket.data;

  // Someone opening the app from a call notification has missed the original event.
  for (const call of calls.values()) {
    if (call.calleeId === userId && !call.answeredAt) {
      socket.emit('call:incoming', { callId: call.callId, chatId: call.chatId, video: call.video, from: call.from });
    }
  }

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
      if (isInDirectCall(peer.peer_id) || isInGroupCall(peer.peer_id)) return ack({ error: 'busy' });
      if (isInDirectCall(userId) || isInGroupCall(userId)) return ack({ error: 'You are already in a call.' });
      // Read fresh: names and photos may have changed since this socket connected.
      const from = publicUser((await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0]);
      const callId = crypto.randomUUID();
      const call = {
        callId, chatId, video, callerId: userId, calleeId: peer.peer_id,
        callerSocket: socket.id, calleeSocket: null, answeredAt: null,
        from, dropped: new Set(), droppedAt: null,
      };
      calls.set(callId, call);
      call.timer = setTimeout(() => finish(io, callId, 'missed', 'no-answer'), RING_TIMEOUT_MS);
      io.to(userRoom(peer.peer_id)).emit('call:incoming', { callId, chatId, video, from });
      ringDevices(call);
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
    clearInterval(call.pushTimer);
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

  // A client whose socket dropped mid-call reattaches here; the media connection never stopped.
  socket.on('call:rejoin', (payload, ack = () => {}) => {
    const call = calls.get(payload?.callId);
    if (!isParty(call, userId) || !call.answeredAt) return ack({ error: 'Call has ended.' });
    if (call.callerId === userId) call.callerSocket = socket.id;
    else call.calleeSocket = socket.id;
    call.dropped.delete(userId);
    if (!call.dropped.size) {
      clearTimeout(call.graceTimer);
      call.graceTimer = null;
      call.droppedAt = null;
    }
    ack({ ok: true });
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
      if (call.callerSocket !== socket.id && call.calleeSocket !== socket.id) continue;
      if (!call.answeredAt) {
        finish(io, call.callId, 'cancelled', 'disconnected');
        continue;
      }
      // Answered calls carry on peer-to-peer, so give the client time to reconnect.
      call.dropped.add(userId);
      call.droppedAt ??= Date.now();
      call.graceTimer ??= setTimeout(() => finish(io, call.callId, 'completed', 'disconnected'), config.callReconnectGraceMs);
    }
  });
}
