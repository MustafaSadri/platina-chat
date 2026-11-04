import { create } from 'zustand';
import * as api from './api.js';
import { uuid } from './format.js';
import { detectInitialLang, errorText } from './i18n.js';

const PAGE = 50;

function sortChats(chats) {
  return Object.values(chats).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : new Date(a.createdAt).getTime();
    const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : new Date(b.createdAt).getTime();
    return tb - ta;
  });
}

/** Inserts or replaces a message keeping confirmed messages sorted by id and pending ones last. */
function mergeMessages(list = [], incoming) {
  const byKey = new Map();
  for (const m of list) byKey.set(m.pending ? `c:${m.clientId}` : m.id, m);
  for (const m of incoming) {
    if (!m.pending && m.clientId) byKey.delete(`c:${m.clientId}`);
    byKey.set(m.pending ? `c:${m.clientId}` : m.id, m);
  }
  const all = [...byKey.values()];
  const confirmed = all.filter((m) => !m.pending).sort((a, b) => a.id - b.id);
  const pending = all.filter((m) => m.pending);
  return [...confirmed, ...pending];
}

function loadTheme() {
  try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
}

export const useStore = create((set, get) => ({
  me: null,
  booted: false,
  users: {},
  online: new Set(),
  chats: {},
  messages: {},
  hasMore: {},
  typing: {},
  activeChatId: null,
  connected: false,
  theme: loadTheme(),
  replyTo: null,
  editing: null,
  forwarding: null,
  toast: null,
  modal: null,
  infoOpen: false,
  jumpTo: null,
  config: { vapidPublicKey: null, maxUploadMb: 100 },

  lang: detectInitialLang(),
  /** The account's saved language wins, except at first sign-in where this device's choice is adopted. */
  setMe: (me) => {
    if (me && me.language && me.language !== get().lang) {
      if (me.mustChangePassword) api.patch('/auth/preferences', { language: get().lang }).catch(() => {});
      else get().setLang(me.language, { persist: false });
    }
    set({ me });
  },
  setLang: (lang, { persist = true } = {}) => {
    try { localStorage.setItem('lang', lang); } catch { /* private mode */ }
    document.documentElement.lang = lang;
    set({ lang });
    if (persist && get().me) api.patch('/auth/preferences', { language: lang }).catch(() => {});
  },
  translations: {}, // messageId -> { status: 'loading'|'done'|'error', text, source, target, shown }
  setTheme: (theme) => {
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
    set({ theme });
  },
  /** Accepts a string (already localized) or an error (localized from its code). */
  showToast: (text, kind = 'info') => {
    const id = Math.random();
    set({ toast: { id, text: typeof text === 'string' ? text : errorText(text), kind } });
    setTimeout(() => get().toast?.id === id && set({ toast: null }), 3500);
  },
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),

  // ---------------------------------------------------------------- bootstrap / sync
  async loadAll() {
    const [chats, users, presence, config] = await Promise.all([
      api.get('/chats'), api.get('/users'), api.get('/presence'), api.get('/config'),
    ]);
    const me = get().me;
    const userMap = { ...get().users };
    for (const u of users.users) userMap[u.id] = u;
    if (me) userMap[me.id] = { ...userMap[me.id], ...me };
    for (const c of chats.chats) if (c.peer) userMap[c.peer.id] = c.peer;
    set({
      chats: Object.fromEntries(chats.chats.map((c) => [c.id, c])),
      users: userMap,
      online: new Set(presence.online),
      config,
      booted: true,
    });
  },

  /** After a reconnect: refresh the list and fill any gap in loaded conversations. */
  async resync() {
    await get().loadAll();
    const { messages } = get();
    await Promise.all(Object.keys(messages).map(async (chatId) => {
      const list = messages[chatId].filter((m) => !m.pending);
      if (!get().chats[chatId]) {
        set((s) => { const m = { ...s.messages }; delete m[chatId]; return { messages: m }; });
        return;
      }
      let after = list.length ? list[list.length - 1].id : 0;
      for (let i = 0; i < 20; i++) {
        const r = after
          ? await api.get(`/chats/${chatId}/messages?after=${after}&limit=100`)
          : await api.get(`/chats/${chatId}/messages?limit=${PAGE}`);
        if (!r.messages.length) break;
        set((s) => ({ messages: { ...s.messages, [chatId]: mergeMessages(s.messages[chatId], r.messages) } }));
        after = r.messages[r.messages.length - 1].id;
        if (r.messages.length < 100) break;
      }
    }));
    get().retryPending();
  },

  async ensureUser(id) {
    if (!id || get().users[id]) return;
    set((s) => ({ users: { ...s.users, [id]: { id, displayName: '…', avatarColor: 0, loading: true } } }));
    try {
      const { user } = await api.get(`/users/${id}`);
      set((s) => ({ users: { ...s.users, [id]: user } }));
    } catch {
      set((s) => ({ users: { ...s.users, [id]: { id, displayName: 'Deleted account', avatarColor: 0 } } }));
    }
  },

  mergeUsers(list) {
    set((s) => {
      const users = { ...s.users };
      for (const u of list) users[u.id] = { ...users[u.id], ...u };
      return { users };
    });
  },

  // ---------------------------------------------------------------- chats
  upsertChat(chat) {
    set((s) => ({
      chats: { ...s.chats, [chat.id]: chat },
      users: chat.peer ? { ...s.users, [chat.peer.id]: { ...s.users[chat.peer.id], ...chat.peer } } : s.users,
    }));
  },
  removeChat(chatId) {
    set((s) => {
      const chats = { ...s.chats };
      delete chats[chatId];
      const messages = { ...s.messages };
      delete messages[chatId];
      return { chats, messages, activeChatId: s.activeChatId === chatId ? null : s.activeChatId };
    });
  },
  sortedChats: () => sortChats(get().chats),

  openChat(chatId, { jumpTo = null } = {}) {
    set({ activeChatId: chatId, replyTo: null, editing: null, jumpTo });
    const url = new URL(window.location.href);
    if (chatId) url.searchParams.set('chat', chatId); else url.searchParams.delete('chat');
    window.history.replaceState(null, '', url);
    if (chatId && (!get().messages[chatId] || jumpTo)) get().loadMessages(chatId, { around: jumpTo });
  },

  async loadMessages(chatId, { before = null, around = null, reset = false } = {}) {
    const q = around ? `around=${around}&limit=${PAGE}` : before ? `before=${before}&limit=${PAGE}` : `limit=${PAGE}`;
    const r = await api.get(`/chats/${chatId}/messages?${q}`);
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: around || reset ? mergeMessages([], r.messages) : mergeMessages(s.messages[chatId], r.messages),
      },
      hasMore: { ...s.hasMore, [chatId]: around ? true : before || reset || !s.messages[chatId] ? r.messages.length >= PAGE : s.hasMore[chatId] },
    }));
    r.messages.forEach((m) => get().ensureUser(m.senderId));
    return r.messages;
  },

  // ---------------------------------------------------------------- incoming events
  receiveMessage(m) {
    const s = get();
    const mine = m.senderId === s.me.id;
    const chat = s.chats[m.chatId];
    get().ensureUser(m.senderId);
    set((st) => {
      const update = { };
      if (st.messages[m.chatId]) update.messages = { ...st.messages, [m.chatId]: mergeMessages(st.messages[m.chatId], [m]) };
      if (chat) {
        const isNewer = !chat.lastMessage || m.id >= chat.lastMessage.id;
        const viewing = st.activeChatId === m.chatId && document.visibilityState === 'visible';
        update.chats = {
          ...st.chats,
          [m.chatId]: {
            ...chat,
            lastMessage: isNewer ? m : chat.lastMessage,
            unread: !mine && !viewing && m.type !== 'system' ? chat.unread + 1 : chat.unread,
            lastReadId: mine ? Math.max(chat.lastReadId, m.id) : chat.lastReadId,
            archived: chat.archived && chat.muted,
          },
        };
      }
      // Drop the sender's typing indicator.
      if (st.typing[m.chatId]?.[m.senderId]) {
        const t = { ...st.typing[m.chatId] };
        delete t[m.senderId];
        update.typing = { ...st.typing, [m.chatId]: t };
      }
      return update;
    });
    if (!chat) api.get(`/chats/${m.chatId}`).then(({ chat: c }) => get().upsertChat(c)).catch(() => {});
  },

  updateMessage(m) {
    set((s) => {
      const update = {};
      if (s.messages[m.chatId]) {
        update.messages = { ...s.messages, [m.chatId]: s.messages[m.chatId].map((x) => (x.id === m.id ? m : x.replyTo?.id === m.id ? { ...x, replyTo: { ...x.replyTo, body: m.body } } : x)) };
      }
      const chat = s.chats[m.chatId];
      if (chat?.lastMessage?.id === m.id) update.chats = { ...s.chats, [m.chatId]: { ...chat, lastMessage: m } };
      return update;
    });
  },

  removeMessage(chatId, messageId) {
    set((s) => {
      const update = {};
      if (s.messages[chatId]) {
        update.messages = {
          ...s.messages,
          [chatId]: s.messages[chatId]
            .filter((x) => x.id !== messageId)
            .map((x) => (x.replyTo?.id === messageId ? { ...x, replyTo: { ...x.replyTo, deleted: true, body: '' } } : x)),
        };
      }
      return update;
    });
    const chat = get().chats[chatId];
    if (chat?.lastMessage?.id === messageId) {
      api.get(`/chats/${chatId}`).then(({ chat: c }) => get().upsertChat({ ...c, members: undefined })).catch(() => {});
    }
  },

  setReactions(chatId, messageId, reactions) {
    set((s) => (s.messages[chatId]
      ? { messages: { ...s.messages, [chatId]: s.messages[chatId].map((x) => (x.id === messageId ? { ...x, reactions } : x)) } }
      : {}));
  },

  applyReceipt({ chatId, userId, readId, deliveredId }) {
    set((s) => {
      const chat = s.chats[chatId];
      if (!chat) return {};
      if (userId === s.me.id) {
        const caughtUp = !chat.lastMessage || readId >= chat.lastMessage.id;
        return { chats: { ...s.chats, [chatId]: { ...chat, lastReadId: Math.max(chat.lastReadId, readId), unread: caughtUp ? 0 : chat.unread } } };
      }
      return {
        chats: {
          ...s.chats,
          [chatId]: {
            ...chat,
            othersReadId: Math.max(chat.othersReadId, readId),
            othersDeliveredId: Math.max(chat.othersDeliveredId, deliveredId),
          },
        },
      };
    });
  },

  setTyping({ chatId, userId, kind }) {
    const until = Date.now() + 5000;
    set((s) => ({ typing: { ...s.typing, [chatId]: { ...s.typing[chatId], [userId]: { until, kind } } } }));
    setTimeout(() => {
      set((s) => {
        const cur = s.typing[chatId]?.[userId];
        if (!cur || cur.until > Date.now()) return {};
        const t = { ...s.typing[chatId] };
        delete t[userId];
        return { typing: { ...s.typing, [chatId]: t } };
      });
    }, 5100);
  },

  setPresence({ userId, online, lastSeenAt }) {
    set((s) => {
      const next = new Set(s.online);
      if (online) next.add(userId); else next.delete(userId);
      const users = s.users[userId] && lastSeenAt ? { ...s.users, [userId]: { ...s.users[userId], lastSeenAt } } : s.users;
      return { online: next, users };
    });
  },

  // ---------------------------------------------------------------- outgoing
  async markRead(chatId) {
    const chat = get().chats[chatId];
    const last = chat?.lastMessage;
    if (!chat || !last || last.id <= chat.lastReadId) {
      if (chat?.unread) set((s) => ({ chats: { ...s.chats, [chatId]: { ...chat, unread: 0 } } }));
      return;
    }
    set((s) => ({ chats: { ...s.chats, [chatId]: { ...chat, unread: 0, lastReadId: last.id } } }));
    try { await api.post(`/chats/${chatId}/read`, { messageId: last.id }); } catch { /* retried on next view */ }
  },

  /** Optimistic send with a client id so retries are deduplicated server-side. */
  async send(chatId, { body = '', fileId = null, file = null, replyTo = null, type }) {
    const clientId = uuid();
    const temp = {
      id: `tmp-${clientId}`, clientId, chatId, senderId: get().me.id, type: file ? (type === 'voice' ? 'voice' : 'file') : 'text',
      body, file, replyTo: replyTo ? { id: replyTo.id, senderId: replyTo.senderId, body: replyTo.body, type: replyTo.type, fileKind: replyTo.file?.kind } : null,
      createdAt: new Date().toISOString(), reactions: [], pending: true,
      payload: { body, clientId, ...(fileId && { fileId }), ...(replyTo && { replyToId: replyTo.id }), ...(type && { type }) },
    };
    set((s) => ({ messages: { ...s.messages, [chatId]: mergeMessages(s.messages[chatId], [temp]) } }));
    return get().deliverPending(chatId, temp);
  },

  /** Uploads a file with a progress bubble, then sends the message that references it. */
  async sendFile(chatId, file, { caption = '', replyTo = null, kind = null, fields = {} } = {}) {
    const clientId = uuid();
    const guess = kind === 'voice' ? 'voice'
      : /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) ? 'image'
        : /^video\/(mp4|webm|quicktime|ogg)$/.test(file.type) ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document';
    const localUrl = ['image', 'video', 'voice', 'audio'].includes(guess) ? URL.createObjectURL(file) : null;
    const tempFile = {
      name: file.name || 'file', size: file.size, kind: guess, mime: file.type, localUrl, uploading: true, progress: 0,
      width: fields.width, height: fields.height, duration: fields.duration, waveform: fields.waveform ? JSON.parse(fields.waveform) : null,
    };
    const temp = {
      id: `tmp-${clientId}`, clientId, chatId, senderId: get().me.id, type: kind === 'voice' ? 'voice' : 'file', body: caption,
      file: tempFile, replyTo: replyTo ? { id: replyTo.id, senderId: replyTo.senderId, body: replyTo.body, type: replyTo.type } : null,
      createdAt: new Date().toISOString(), reactions: [], pending: true,
    };
    const patchTemp = (fn) => set((s) => ({
      messages: { ...s.messages, [chatId]: (s.messages[chatId] || []).map((m) => (m.clientId === clientId && m.pending ? fn(m) : m)) },
    }));
    set((s) => ({ messages: { ...s.messages, [chatId]: mergeMessages(s.messages[chatId], [temp]) } }));
    try {
      const uploaded = await api.upload(chatId, file, { kind, ...fields }, (p) => patchTemp((m) => ({ ...m, file: { ...m.file, progress: p } })));
      patchTemp((m) => ({ ...m, file: { ...uploaded, localUrl }, payload: { body: caption, fileId: uploaded.id, clientId, ...(replyTo && { replyToId: replyTo.id }), ...(kind === 'voice' && { type: 'voice' }) } }));
      const pending = get().messages[chatId].find((m) => m.clientId === clientId && m.pending);
      return await get().deliverPending(chatId, pending);
    } catch (err) {
      patchTemp((m) => ({ ...m, failed: true, file: { ...m.file, uploading: false } }));
      get().showToast(err, 'error');
      return null;
    }
  },

  async deliverPending(chatId, temp) {
    if (!temp.payload) return null; // upload never finished; user must resend the file
    try {
      const { message } = await api.post(`/chats/${chatId}/messages`, temp.payload);
      get().receiveMessage(message);
      return message;
    } catch (err) {
      if (err.status === 0) {
        set((s) => ({ messages: { ...s.messages, [chatId]: (s.messages[chatId] || []).map((m) => (m.clientId === temp.clientId && m.pending ? { ...m, retrying: true } : m)) } }));
      } else {
        set((s) => ({ messages: { ...s.messages, [chatId]: (s.messages[chatId] || []).map((m) => (m.clientId === temp.clientId && m.pending ? { ...m, failed: true, error: err.message } : m)) } }));
        get().showToast(err, 'error');
      }
      return null;
    }
  },

  retryPending() {
    const { messages } = get();
    for (const [chatId, list] of Object.entries(messages)) {
      for (const m of list) if (m.pending && (m.retrying || m.failed)) get().deliverPending(Number(chatId), m);
    }
  },

  // ---------------------------------------------------------------- translation
  /** Translates a message (EN<->RU). target 'auto' = the other language of the pair. */
  async translateMessage(m, target = 'auto', { silent = false } = {}) {
    const cur = get().translations[m.id];
    if (cur?.status === 'done' && (target === 'auto' || cur.target === target)) {
      set((s) => ({ translations: { ...s.translations, [m.id]: { ...cur, shown: true } } }));
      return;
    }
    if (cur?.status === 'loading') return;
    set((s) => ({ translations: { ...s.translations, [m.id]: { status: 'loading', shown: true } } }));
    try {
      const { translation } = await api.post(`/messages/${m.id}/translate`, { target });
      set((s) => ({ translations: { ...s.translations, [m.id]: { status: 'done', shown: !translation.unchanged, ...translation } } }));
    } catch (err) {
      set((s) => ({ translations: { ...s.translations, [m.id]: { status: 'error', shown: false } } }));
      if (!silent) get().showToast(errorText(err), 'error');
    }
  },
  hideTranslation(id) {
    set((s) => ({ translations: { ...s.translations, [id]: { ...s.translations[id], shown: false } } }));
  },

  discardPending(chatId, clientId) {
    set((s) => ({ messages: { ...s.messages, [chatId]: (s.messages[chatId] || []).filter((m) => !(m.pending && m.clientId === clientId)) } }));
  },
}));
