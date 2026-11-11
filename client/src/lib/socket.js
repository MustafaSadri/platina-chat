import { io } from 'socket.io-client';
import { useStore } from './store.js';
import { notifyMessage } from './notify.js';
import { handleCallEvent, rejoinCall } from './call.js';
import { handleGroupCallEvent, rejoinGroupCall } from './groupCall.js';

let socket = null;

export const getSocket = () => socket;

// The server only sends a push when the app isn't on screen, so it has to know which is the case.
const isVisible = () => document.visibilityState === 'visible';
document.addEventListener('visibilitychange', () => {
  if (socket?.connected) socket.emit('visibility', { visible: isVisible() });
});

export function connectSocket() {
  if (socket) return socket;
  socket = io({
    transports: ['websocket', 'polling'],
    withCredentials: true,
    reconnectionDelayMax: 10_000,
    auth: (send) => send({ visible: isVisible() }),
  });
  const s = useStore.getState;
  let firstConnect = true;

  socket.on('connect', () => {
    useStore.setState({ connected: true, groupCalls: {} }); // the server re-sends running calls
    if (!firstConnect) {
      s().resync().catch(() => {});
      rejoinCall();
      rejoinGroupCall();
    }
    firstConnect = false;
  });
  socket.on('disconnect', () => useStore.setState({ connected: false }));
  socket.on('connect_error', (err) => {
    useStore.setState({ connected: false });
    if (err.message === 'UNAUTHENTICATED') window.location.reload();
  });

  socket.on('message:new', (m) => {
    s().receiveMessage(m);
    if (m.senderId !== s().me.id) {
      socket.emit('delivered', { chatId: m.chatId, messageId: m.id });
      notifyMessage(m);
    }
  });
  socket.on('message:updated', (m) => s().updateMessage(m));
  socket.on('message:deleted', ({ chatId, messageId }) => s().removeMessage(chatId, messageId));
  socket.on('message:reactions', ({ chatId, messageId, reactions }) => s().setReactions(chatId, messageId, reactions));
  socket.on('receipt', (r) => s().applyReceipt(r));
  socket.on('typing', (t) => s().setTyping(t));
  socket.on('presence', (p) => s().setPresence(p));
  socket.on('chat:updated', (c) => s().upsertChat(c));
  socket.on('chat:removed', ({ chatId }) => s().removeChat(chatId));
  socket.on('chat:pins', ({ chatId }) => window.dispatchEvent(new CustomEvent('pins-changed', { detail: chatId })));
  socket.on('chat:members-changed', ({ chatId }) => window.dispatchEvent(new CustomEvent('members-changed', { detail: chatId })));
  socket.on('directory:changed', () => s().loadAll().catch(() => {}));
  socket.on('me:updated', () => window.dispatchEvent(new Event('me-updated')));

  for (const ev of ['call:incoming', 'call:accepted', 'call:signal', 'call:ended']) {
    socket.on(ev, (data) => handleCallEvent(ev, data));
  }
  for (const ev of ['group-call:ringing', 'group-call:update', 'group-call:peer-joined', 'group-call:peer-left', 'group-call:signal', 'group-call:ended']) {
    socket.on(ev, (data) => handleGroupCallEvent(ev, data));
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

// Throttled per chat; reset after sending because a new message clears the indicator on the other side.
const lastTyping = new Map();
export function sendTyping(chatId, kind = 'text') {
  const now = Date.now();
  if (now - (lastTyping.get(chatId) || 0) < 3000) return;
  lastTyping.set(chatId, now);
  socket?.emit('typing', { chatId, kind });
}
export const resetTyping = (chatId) => lastTyping.delete(chatId);
