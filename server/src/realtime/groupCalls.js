import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { publicUser } from '../services/auth.js';
import { getMessage } from '../services/chats.js';
import { sendToUser } from '../services/push.js';
import { chatMemberIds, getIo, isForeground, toChat, toUsers } from './bus.js';
import { isInDirectCall } from './calls.js';

// Group calls connect every participant directly to every other one (a mesh), so the server only
// relays setup messages. Upload use grows with each person, which is why calls are capped.
// State is per server instance, like 1:1 calls (see docs/ARCHITECTURE.md).
export const MAX_PARTICIPANTS = 8;
const RING_TIMEOUT_MS = 45_000;
const PUSH_RING_INTERVAL_MS = 7_000;
const PUSH_RING_COUNT = 6;

const calls = new Map();
const logError = (err) => console.error('[group-calls]', err.message);

const callInChat = (chatId) => [...calls.values()].find((c) => c.chatId === chatId);

export const isInGroupCall = (userId) => [...calls.values()].some((c) => c.participants.has(userId));

const summary = (call) => ({
  callId: call.callId,
  chatId: call.chatId,
  title: call.title,
  video: call.video,
  from: call.from,
  ringing: call.ringing,
  participantIds: [...call.participants.keys()],
});

const announce = (call) => toChat(call.chatId, 'group-call:update', summary(call)).catch(logError);

async function loadGroup(chatId, userId) {
  const { rows } = await query(
    `SELECT c.title FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
      WHERE c.id = $1 AND c.type = 'group' AND c.archived_at IS NULL`,
    [chatId, userId],
  );
  return rows[0] || null;
}

async function loadUser(userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  return publicUser(rows[0]);
}

async function recordCall(call, status) {
  const durationSec = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;
  const { rows } = await query(
    `INSERT INTO messages (chat_id, sender_id, type, body, meta) VALUES ($1, $2, 'call', '', $3) RETURNING id`,
    [call.chatId, call.from.id, { video: call.video, status, durationSec, group: true, participants: call.everJoined.size }],
  );
  await toChat(call.chatId, 'message:new', await getMessage(rows[0].id));
}

function stopRinging(call) {
  clearTimeout(call.ringTimer);
  clearInterval(call.pushTimer);
  call.ringing = false;
}

function endCall(call) {
  if (!calls.delete(call.callId)) return;
  stopRinging(call);
  for (const timer of call.dropped.values()) clearTimeout(timer);
  toChat(call.chatId, 'group-call:ended', { callId: call.callId, chatId: call.chatId }).catch(logError);
  recordCall(call, call.answeredAt ? 'completed' : 'missed').catch(logError);
}

function removeParticipant(call, userId) {
  if (!call.participants.delete(userId)) return;
  clearTimeout(call.dropped.get(userId));
  call.dropped.delete(userId);
  if (!call.participants.size) {
    endCall(call);
    return;
  }
  const io = getIo();
  for (const p of call.participants.values()) io.to(p.socketId).emit('group-call:peer-left', { callId: call.callId, userId });
  announce(call);
}

/** Notifies members who aren't looking at the app, repeating while the call rings. */
function ringDevices(call) {
  let count = 0;
  const send = async () => {
    count += 1;
    if (!call.ringing || count > PUSH_RING_COUNT) {
      clearInterval(call.pushTimer);
      return;
    }
    const { rows } = await query(
      `SELECT cm.user_id FROM chat_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = $1 AND NOT cm.muted AND u.status = 'active'`,
      [call.chatId],
    );
    await Promise.all(rows.map(async ({ user_id: uid }) => {
      if (call.participants.has(uid) || call.declined.has(uid) || (await isForeground(uid))) return;
      await sendToUser(uid, {
        title: call.title,
        body: `${call.video ? '📹' : '📞'} ${call.from.displayName}: group call`,
        chatId: call.chatId,
        callId: call.callId,
        type: 'call',
        tag: `call-${call.callId}-${count}`,
      }, { ttl: 30 });
    }));
  };
  send().catch(logError);
  call.pushTimer = setInterval(() => send().catch(logError), PUSH_RING_INTERVAL_MS);
  call.pushTimer.unref?.();
}

function createCall({ chatId, title, video, from }) {
  const call = {
    callId: crypto.randomUUID(), chatId, title, video, from,
    participants: new Map(), // userId -> { socketId }
    everJoined: new Set(),
    declined: new Set(),
    dropped: new Map(), // userId -> timer while waiting for them to reconnect
    answeredAt: null,
    ringing: true,
  };
  call.ringTimer = setTimeout(() => {
    stopRinging(call);
    if (call.answeredAt) announce(call);
    else endCall(call); // nobody picked up
  }, RING_TIMEOUT_MS);
  call.ringTimer.unref?.();
  calls.set(call.callId, call);
  return call;
}

function addParticipant(call, socket) {
  const { userId } = socket.data;
  const peers = [...call.participants.keys()];
  call.participants.set(userId, { socketId: socket.id });
  call.everJoined.add(userId);
  if (peers.length && !call.answeredAt) call.answeredAt = Date.now();
  return peers;
}

/** The notification's Decline button: stop ringing this person. */
export function declineGroupCall(callId, userId) {
  const call = calls.get(callId);
  if (call) call.declined.add(userId);
  return Boolean(call);
}

export function registerGroupCallHandlers(io, socket, limit) {
  const { userId } = socket.data;

  const join = async (call, ack) => {
    const taken = call.participants.get(userId);
    if (taken) return ack({ error: 'You are already in this call on another device.' });
    if (call.participants.size >= MAX_PARTICIPANTS) return ack({ error: 'full' });
    if (isInDirectCall(userId) || isInGroupCall(userId)) return ack({ error: 'You are already in a call.' });
    const peers = addParticipant(call, socket);
    // Answer first: the newcomer must know the call before peers start connecting to it.
    ack({ ...summary(call), peers });
    const user = await loadUser(userId);
    for (const id of peers) {
      const p = call.participants.get(id);
      if (p) io.to(p.socketId).emit('group-call:peer-joined', { callId: call.callId, user });
    }
    await announce(call);
  };

  socket.on('group-call:start', async (payload, ack = () => {}) => {
    try {
      const chatId = Number(payload?.chatId);
      const group = await loadGroup(chatId, userId);
      if (!group) return ack({ error: 'Group calls are only available to group members.' });
      const running = callInChat(chatId);
      if (running) return await join(running, ack);
      if (isInDirectCall(userId) || isInGroupCall(userId)) return ack({ error: 'You are already in a call.' });
      const call = createCall({ chatId, title: group.title, video: !!payload?.video, from: await loadUser(userId) });
      addParticipant(call, socket);
      ack({ ...summary(call), peers: [] });
      const members = await chatMemberIds(chatId);
      toUsers(members.filter((id) => id !== userId), 'group-call:ringing', summary(call));
      ringDevices(call);
      await announce(call);
    } catch (err) {
      logError(err);
      ack({ error: 'Could not start the call.' });
    }
  });

  socket.on('group-call:join', async (payload, ack = () => {}) => {
    try {
      const call = calls.get(payload?.callId);
      if (!call || !(await loadGroup(call.chatId, userId))) return ack({ error: 'Call is no longer available.' });
      await join(call, ack);
    } catch (err) {
      logError(err);
      ack({ error: 'Could not join the call.' });
    }
  });

  socket.on('group-call:leave', (payload) => {
    const call = calls.get(payload?.callId);
    if (call) removeParticipant(call, userId);
  });

  socket.on('group-call:decline', (payload) => { declineGroupCall(payload?.callId, userId); });

  // Relays connection setup between two participants of the same call.
  socket.on('group-call:signal', (payload) => {
    if (!limit()) return;
    const call = calls.get(payload?.callId);
    if (call?.participants.get(userId)?.socketId !== socket.id) return;
    const target = call.participants.get(Number(payload?.to));
    if (target) io.to(target.socketId).emit('group-call:signal', { callId: call.callId, from: userId, data: payload.data });
  });

  socket.on('group-call:rejoin', (payload, ack = () => {}) => {
    const call = calls.get(payload?.callId);
    const me = call?.participants.get(userId);
    if (!me) return ack({ error: 'Call has ended.' });
    me.socketId = socket.id;
    clearTimeout(call.dropped.get(userId));
    call.dropped.delete(userId);
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const call of calls.values()) {
      if (call.participants.get(userId)?.socketId !== socket.id || call.dropped.has(userId)) continue;
      call.dropped.set(userId, setTimeout(() => removeParticipant(call, userId), config.callReconnectGraceMs));
    }
  });

  // Tell a newly connected member about calls running in their groups.
  (async () => {
    if (!calls.size) return;
    const { rows } = await query('SELECT chat_id FROM chat_members WHERE user_id = $1', [userId]);
    const mine = new Set(rows.map((r) => r.chat_id));
    for (const call of calls.values()) {
      if (!mine.has(call.chatId)) continue;
      socket.emit('group-call:update', summary(call));
      if (call.ringing && !call.participants.has(userId) && !call.declined.has(userId)) socket.emit('group-call:ringing', summary(call));
    }
  })().catch(logError);
}
