import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { listTime, messagePreview } from '../lib/format.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';
import { ContextMenu, useContextMenu } from './ContextMenu.jsx';
import { MessageStatus } from './Message.jsx';
import { useT } from '../lib/i18n.js';

const typingIds = (typing) => Object.keys(typing || {}).filter((id) => typing[id].until > Date.now());

export function TypingText({ chat }) {
  const t = useT();
  const typing = useStore((s) => s.typing[chat.id]);
  const users = useStore((s) => s.users);
  const ids = typingIds(typing);
  if (!ids.length) return null;
  const voice = ids.some((id) => typing[id].kind === 'voice');
  const verb = t(voice ? 'recording voice' : 'typing');
  if (chat.type === 'direct') return <span className="accent">{verb}…</span>;
  const names = ids.map((id) => users[id]?.displayName?.split(' ')[0] || t('Someone'));
  return <span className="accent">{names.length > 1 ? t('{n} people are {verb}…', { n: names.length, verb }) : t('{name} is {verb}…', { name: names[0], verb })}</span>;
}

function ChatItem({ chat, active, onContext }) {
  const t = useT();
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const online = useStore((s) => (chat.peer ? s.online.has(chat.peer.id) : false));
  const isTyping = useStore((s) => typingIds(s.typing[chat.id]).length > 0);
  const m = chat.lastMessage;
  const longPress = useRef();
  const pressStart = useRef({ x: 0, y: 0 });
  let prefix = '';
  if (m && m.type !== 'system' && m.type !== 'call') {
    if (m.senderId === me.id) prefix = t('You: ');
    else if (chat.type === 'group') prefix = `${users[m.senderId]?.displayName?.split(' ')[0] || ''}: `;
  }
  return (
    <button
      className={`chat-item ${active ? 'active' : ''}`}
      onClick={() => useStore.getState().openChat(chat.id)}
      onContextMenu={(e) => { e.preventDefault(); onContext(e, chat); }}
      onTouchStart={(e) => {
        const p = e.touches[0];
        pressStart.current = { x: p.clientX, y: p.clientY };
        longPress.current = setTimeout(() => onContext({ clientX: p.clientX, clientY: p.clientY }, chat), 500);
      }}
      onTouchEnd={() => clearTimeout(longPress.current)}
      onTouchCancel={() => clearTimeout(longPress.current)}
      onTouchMove={(e) => {
        const p = e.touches[0];
        if (Math.hypot(p.clientX - pressStart.current.x, p.clientY - pressStart.current.y) > 10) clearTimeout(longPress.current);
      }}
    >
      <Avatar name={chat.title} color={chat.avatarColor} src={chat.avatarUrl} online={online} group={chat.type === 'group'} />
      <div className="chat-item-body">
        <div className="row">
          <span className="chat-item-title">
            {chat.type === 'group' && <Icon name="users" size={15} className="muted-icon" />}
            {chat.title}
            {chat.muted && <Icon name="bellOff" size={14} className="muted-icon" />}
          </span>
          <span className="chat-item-time">
            {m && m.senderId === me.id && m.type !== 'system' && <MessageStatus message={m} chat={chat} />}
            {m ? listTime(m.createdAt) : ''}
          </span>
        </div>
        <div className="row">
          <span className="chat-item-preview">
            {isTyping ? <TypingText chat={chat} /> : (
              <>{prefix && <span className="sender">{prefix}</span>}{m ? messagePreview(m, users) : <i>{t('No messages yet')}</i>}</>
            )}
          </span>
          {chat.unread > 0 ? <span className={`badge ${chat.muted ? 'muted' : ''}`}>{chat.unread > 999 ? '999+' : chat.unread}</span>
            : chat.pinned ? <Icon name="pin" size={15} className="muted-icon" /> : null}
        </div>
      </div>
    </button>
  );
}

function SearchResults({ q }) {
  const t = useT();
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const [messages, setMessages] = useState(null);

  useEffect(() => {
    setMessages(null);
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api.get(`/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal }).then((r) => setMessages(r.messages)).catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q]);

  const lower = q.toLowerCase();
  const chatHits = Object.values(chats).filter((c) => c.title.toLowerCase().includes(lower));
  const directPeers = new Set(Object.values(chats).filter((c) => c.peer).map((c) => c.peer.id));
  const people = Object.values(users).filter((u) => u.id !== me.id && u.status === 'active' && !directPeers.has(u.id)
    && (u.displayName.toLowerCase().includes(lower) || u.username?.toLowerCase().includes(lower)));

  async function openDirect(u) {
    try {
      const { chat } = await api.post('/chats/direct', { userId: u.id });
      useStore.getState().upsertChat(chat);
      useStore.getState().openChat(chat.id);
    } catch (err) {
      useStore.getState().showToast(err, 'error');
    }
  }

  return (
    <div className="search-results">
      {chatHits.length > 0 && <div className="section-title">{t('Chats')}</div>}
      {chatHits.map((c) => (
        <button key={c.id} className="chat-item compact" onClick={() => useStore.getState().openChat(c.id)}>
          <Avatar name={c.title} color={c.avatarColor} src={c.avatarUrl} size={40} group={c.type === 'group'} />
          <div className="chat-item-body"><span className="chat-item-title">{c.title}</span></div>
        </button>
      ))}
      {people.length > 0 && <div className="section-title">{t('People')}</div>}
      {people.slice(0, 20).map((u) => (
        <button key={u.id} className="chat-item compact" onClick={() => openDirect(u)}>
          <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={40} />
          <div className="chat-item-body">
            <span className="chat-item-title">{u.displayName}</span>
            <span className="chat-item-preview">@{u.username}{u.title ? ` · ${u.title}` : ''}</span>
          </div>
        </button>
      ))}
      <div className="section-title">{t('Messages')}</div>
      {messages === null && <div className="muted pad">{t('Searching…')}</div>}
      {messages?.length === 0 && <div className="muted pad">{t('No messages found')}</div>}
      {messages?.map((m) => {
        const chat = chats[m.chatId];
        if (!chat) return null;
        return (
          <button key={m.id} className="chat-item" onClick={() => useStore.getState().openChat(m.chatId, { jumpTo: m.id })}>
            <Avatar name={chat.title} color={chat.avatarColor} src={chat.avatarUrl} size={44} group={chat.type === 'group'} />
            <div className="chat-item-body">
              <div className="row">
                <span className="chat-item-title">{chat.title}</span>
                <span className="chat-item-time">{listTime(m.createdAt)}</span>
              </div>
              <span className="chat-item-preview">
                {chat.type === 'group' && <span className="sender">{users[m.senderId]?.displayName?.split(' ')[0]}: </span>}
                <Highlight text={messagePreview(m, users)} q={q} />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  const start = Math.max(0, i - 30);
  return <>{start > 0 && '…'}{text.slice(start, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export default function Sidebar() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const chatsMap = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const me = useStore((s) => s.me);
  const theme = useStore((s) => s.theme);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const ctx = useContextMenu();

  const chats = useMemo(() => useStore.getState().sortedChats(), [chatsMap]);
  const visible = chats.filter((c) => (showArchived ? c.archived : !c.archived));
  const archivedCount = chats.filter((c) => c.archived).length;
  const archivedUnread = chats.filter((c) => c.archived && c.unread > 0).length;

  const open = useStore.getState().openModal;
  const setSetting = async (chat, patch, msg) => {
    try {
      await api.patch(`/chats/${chat.id}/settings`, patch);
      if (msg) useStore.getState().showToast(msg);
    } catch (err) { useStore.getState().showToast(err, 'error'); }
  };

  function deleteChatItem(chat) {
    if (chat.type !== 'direct') return null;
    const status = (chat.peer && useStore.getState().users[chat.peer.id]?.status) || chat.peer?.status;
    const inactive = status && status !== 'active';
    const label = t(inactive ? 'Delete user for me' : 'Delete chat for me');
    return {
      icon: 'trash',
      label,
      danger: true,
      onClick: () => open({
        type: 'confirm',
        title: label,
        text: t('Remove {title} from your chat list? The history is cleared for you only. Other people keep their copy.', { title: chat.title }),
        confirm: t('Delete'),
        danger: true,
        onConfirm: () => api.post(`/chats/${chat.id}/hide`),
      }),
    };
  }

  function chatMenu(e, chat) {
    ctx.open(e, [
      { icon: 'pin', label: t(chat.pinned ? 'Unpin' : 'Pin to top'), onClick: () => setSetting(chat, { pinned: !chat.pinned }) },
      { icon: chat.muted ? 'bell' : 'bellOff', label: t(chat.muted ? 'Unmute' : 'Mute'), onClick: () => setSetting(chat, { muted: !chat.muted }) },
      { icon: 'archive', label: t(chat.archived ? 'Unarchive' : 'Archive'), onClick: () => setSetting(chat, { archived: !chat.archived }, t(chat.archived ? 'Chat unarchived' : 'Chat archived')) },
      { icon: 'check', label: t('Mark as read'), onClick: () => useStore.getState().markRead(chat.id) },
      { icon: 'trash', label: t('Clear history (for me)'), danger: true, onClick: () => open({ type: 'confirm', title: t('Clear history'), text: t('Clear the history of “{title}” for you? Other members keep their copy.', { title: chat.title }), confirm: t('Clear'), danger: true, onConfirm: () => api.post(`/chats/${chat.id}/clear`).then(() => useStore.getState().loadMessages(chat.id, { reset: true })) }) },
      deleteChatItem(chat),
      chat.type === 'group' && { icon: 'logout', label: t('Leave group'), danger: true, onClick: () => open({ type: 'confirm', title: t('Leave group'), text: t('Leave “{title}”?', { title: chat.title }), confirm: t('Leave'), danger: true, onConfirm: () => api.del(`/chats/${chat.id}/members/${me.id}`) }) },
    ].filter(Boolean));
  }

  const cycleTheme = () => useStore.getState().setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light');

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        {showArchived ? (
          <button className="icon-btn" onClick={() => setShowArchived(false)} aria-label="Back"><Icon name="back" /></button>
        ) : (
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="Menu"><Icon name="menu" /></button>
        )}
        {showArchived ? <div className="sidebar-title">{t('Archived chats')}</div> : (
          <div className="search-box">
            <Icon name="search" size={18} />
            <input placeholder={t('Search')} value={q} onChange={(e) => setQ(e.target.value)} />
            {q && <button className="icon-btn tiny" onClick={() => setQ('')} aria-label="Clear search"><Icon name="close" size={16} /></button>}
          </div>
        )}
      </div>

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(false)} />
          <div className="drawer" onClick={() => setMenu(false)}>
            <div className="drawer-me">
              <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={56} />
              <div>
                <div className="strong">{me.displayName}</div>
                <div className="muted small">@{me.username}{me.title ? ` · ${me.title}` : ''}</div>
              </div>
            </div>
            <button className="drawer-item" onClick={() => open({ type: 'newChat' })}><Icon name="user" /> {t('New message')}</button>
            {me.canCreateGroups && <button className="drawer-item" onClick={() => open({ type: 'newGroup' })}><Icon name="users" /> {t('New group')}</button>}
            <button className="drawer-item" onClick={() => setShowArchived(true)}><Icon name="archive" /> {t('Archived chats')} {archivedCount > 0 && <span className="muted">({archivedCount})</span>}</button>
            <button className="drawer-item" onClick={() => open({ type: 'settings' })}><Icon name="settings" /> {t('Settings')}</button>
            {me.role === 'admin' && <button className="drawer-item" onClick={() => open({ type: 'admin' })}><Icon name="shield" /> {t('Admin panel')}</button>}
            <button className="drawer-item" onClick={(e) => { e.stopPropagation(); cycleTheme(); }}>
              <Icon name={theme === 'dark' ? 'moon' : 'sun'} /> {t('Theme')}: {t(theme[0].toUpperCase() + theme.slice(1))}
            </button>
            <button className="drawer-item" onClick={(e) => { e.stopPropagation(); useStore.getState().setLang(lang === 'en' ? 'ru' : 'en'); }}>
              <Icon name="globe" /> {t('Language')}: {lang === 'en' ? 'English' : 'Русский'}
            </button>
          </div>
        </>
      )}

      <div className="chat-list">
        {q.trim() ? <SearchResults q={q.trim()} /> : (
          <>
            {!showArchived && archivedCount > 0 && (
              <button className="chat-item archived-row" onClick={() => setShowArchived(true)}>
                <div className="avatar archive-avatar"><Icon name="archive" /></div>
                <div className="chat-item-body">
                  <span className="chat-item-title">{t('Archived chats')}</span>
                  <span className="chat-item-preview">{t('chats', { n: archivedCount })}</span>
                </div>
                {archivedUnread > 0 && <span className="badge muted">{archivedUnread}</span>}
              </button>
            )}
            {visible.map((c) => <ChatItem key={c.id} chat={c} active={c.id === activeChatId} onContext={chatMenu} />)}
            {!visible.length && (
              <div className="empty-list">
                <p className="muted">{t(showArchived ? 'No archived chats.' : 'No conversations yet.')}</p>
                {!showArchived && <button className="btn primary" onClick={() => open({ type: 'newChat' })}>{t('Start a conversation')}</button>}
              </div>
            )}
          </>
        )}
      </div>
      {!q && !showArchived && (
        <button className="fab" onClick={() => open({ type: me.canCreateGroups ? 'compose' : 'newChat' })} aria-label="New message">
          <Icon name="edit" />
        </button>
      )}
      <ContextMenu {...ctx} />
    </aside>
  );
}
