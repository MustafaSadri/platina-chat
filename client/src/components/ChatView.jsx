import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { dayLabel, isSameDay, lastSeen, messagePreview } from '../lib/format.js';
import { startCall } from '../lib/call.js';
import { joinGroupCall, startGroupCall, useGroupCall } from '../lib/groupCall.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';
import Message from './Message.jsx';
import Composer from './Composer.jsx';
import { ContextMenu, useContextMenu } from './ContextMenu.jsx';
import { TypingText } from './Sidebar.jsx';
import { t as tr, useT } from '../lib/i18n.js';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅'];

function ChatHeader({ chat, onSearch }) {
  const t = useT();
  const online = useStore((s) => (chat.peer ? s.online.has(chat.peer.id) : false));
  const peer = useStore((s) => (chat.peer ? s.users[chat.peer.id] : null));
  const typing = useStore((s) => Object.values(s.typing[chat.id] || {}).some((x) => x.until > Date.now()));
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(timer); }, []);

  let status;
  if (typing) status = <TypingText chat={chat} />;
  else if (chat.type === 'direct') status = peer?.status && peer.status !== 'active' ? t('account inactive') : lastSeen(peer, online);
  else status = t('members', { n: chat.memberCount });

  const canCall = chat.type === 'direct' && peer?.status === 'active';
  const toggleInfo = () => useStore.setState((s) => ({ infoOpen: !s.infoOpen }));

  return (
    <header className="chat-header">
      <button className="icon-btn back-btn" onClick={() => useStore.getState().openChat(null)} aria-label={t('Back')}><Icon name="back" /></button>
      <button className="chat-header-main" onClick={toggleInfo}>
        <Avatar name={chat.title} color={chat.avatarColor} src={chat.avatarUrl} size={42} group={chat.type === 'group'} />
        <div className="chat-header-text">
          <div className="chat-title">{chat.title}</div>
          <div className={`chat-status ${online && !typing ? 'online' : ''}`}>{status}</div>
        </div>
      </button>
      <div className="chat-actions">
        <button className="icon-btn" onClick={onSearch} aria-label="Search in chat"><Icon name="search" /></button>
        {canCall && <button className="icon-btn" onClick={() => startCall(chat, false)} aria-label="Voice call" title={t('Call')}><Icon name="phone" /></button>}
        {canCall && <button className="icon-btn" onClick={() => startCall(chat, true)} aria-label="Video call" title={t('Video call')}><Icon name="video" /></button>}
        {chat.type === 'group' && <button className="icon-btn" onClick={() => startGroupCall(chat, false)} aria-label="Group voice call" title={t('Group call')}><Icon name="phone" /></button>}
        {chat.type === 'group' && <button className="icon-btn" onClick={() => startGroupCall(chat, true)} aria-label="Group video call" title={t('Group video call')}><Icon name="video" /></button>}
        <button className="icon-btn" onClick={toggleInfo} aria-label="Chat info"><Icon name="info" /></button>
      </div>
    </header>
  );
}

function GroupCallBar({ chatId }) {
  const t = useT();
  const call = useStore((s) => s.groupCalls[chatId]);
  const mine = useGroupCall((s) => s.callId);
  if (!call || call.callId === mine) return null;
  return (
    <div className="group-call-bar">
      <Icon name={call.video ? 'video' : 'phone'} className="accent" />
      <div className="grow">
        <div className="small strong">{t(call.video ? 'Group video call' : 'Group call')}</div>
        <div className="small muted">{t('{n} in the call', { n: call.participantIds.length })}</div>
      </div>
      <button className="btn primary small" onClick={() => joinGroupCall(call)}>{t('Join')}</button>
    </div>
  );
}

function SearchBar({ chatId, onClose, onJump }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const timer = setTimeout(() => {
      api.get(`/search?q=${encodeURIComponent(q.trim())}&chatId=${chatId}`).then((r) => {
        setResults(r.messages);
        setIdx(0);
        if (r.messages[0]) onJump(r.messages[0].id);
      }).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [q, chatId]);
  const go = (d) => {
    const n = idx + d;
    if (n < 0 || n >= results.length) return;
    setIdx(n);
    onJump(results[n].id);
  };
  return (
    <header className="chat-header search-mode">
      <button className="icon-btn" onClick={onClose} aria-label="Close search"><Icon name="close" /></button>
      <input autoFocus className="chat-search-input" placeholder={t('Search messages')} value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') go(e.shiftKey ? -1 : 1); }} />
      <span className="muted small nowrap">{q.trim() ? (results.length ? t('{i} of {n}', { i: idx + 1, n: results.length }) : t('No results')) : ''}</span>
      <button className="icon-btn" disabled={idx >= results.length - 1} onClick={() => go(1)} aria-label="Older"><Icon name="back" className="rot-90" /></button>
      <button className="icon-btn" disabled={idx <= 0} onClick={() => go(-1)} aria-label="Newer"><Icon name="back" className="rot-270" /></button>
    </header>
  );
}

function PinnedBar({ chatId, onJump }) {
  const t = useT();
  const [pins, setPins] = useState([]);
  const [i, setI] = useState(0);
  const users = useStore((s) => s.users);
  const load = useCallback(() => api.get(`/chats/${chatId}/pins`).then((r) => { setPins(r.messages); setI(0); }).catch(() => {}), [chatId]);
  useEffect(() => {
    load();
    const h = (e) => e.detail === chatId && load();
    window.addEventListener('pins-changed', h);
    return () => window.removeEventListener('pins-changed', h);
  }, [chatId, load]);
  if (!pins.length) return null;
  const p = pins[i % pins.length];
  return (
    <button className="pinned-bar" onClick={() => { onJump(p.id); setI((x) => (x + 1) % pins.length); }}>
      <div className="pinned-lines">{pins.slice(0, 4).map((_, k) => <span key={k} className={k === i % pins.length ? 'on' : ''} />)}</div>
      <div className="pinned-text">
        <div className="accent small strong">{t('Pinned message')}{pins.length > 1 ? ` #${pins.length - (i % pins.length)}` : ''}</div>
        <div className="ellipsis small">{messagePreview(p, users)}</div>
      </div>
      <Icon name="pin" size={18} className="muted-icon" />
    </button>
  );
}

const NO_ZOOM = { scale: 1, x: 0, y: 0 };
const touchDistance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/** Full-screen photo: pinch or double-tap to zoom, drag to look around, Back (or the phone's back gesture) to close. */
function MediaViewer({ file, onClose }) {
  const t = useT();
  const [zoom, setZoom] = useState(NO_ZOOM);
  const [saving, setSaving] = useState(false);
  const gesture = useRef(null);
  const lastTap = useRef(0);
  const lastTouch = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Opening adds a history step, so Android's back button and iPhone's back swipe close the photo, not the app.
  useEffect(() => {
    window.history.pushState({ viewer: true }, '');
    const onPop = () => closeRef.current();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); window.history.back(); } };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('keydown', onKey, true); };
  }, []);
  const close = () => (window.history.state?.viewer ? window.history.back() : onClose());

  const toggleZoom = () => setZoom((z) => (z.scale > 1 ? NO_ZOOM : { scale: 2.5, x: 0, y: 0 }));
  const onTouchStart = (e) => {
    lastTouch.current = Date.now();
    if (e.touches.length === 2) {
      gesture.current = { kind: 'pinch', dist: touchDistance(e.touches[0], e.touches[1]), start: zoom };
      return;
    }
    const p = e.touches[0];
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      gesture.current = null;
      toggleZoom();
      return;
    }
    lastTap.current = now;
    gesture.current = { kind: 'pan', x: p.clientX, y: p.clientY, start: zoom };
  };
  const onTouchMove = (e) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && e.touches.length === 2) {
      const scale = Math.min(5, Math.max(1, (g.start.scale * touchDistance(e.touches[0], e.touches[1])) / g.dist));
      setZoom({ ...g.start, scale });
    } else if (g.kind === 'pan' && g.start.scale > 1) {
      const p = e.touches[0];
      setZoom({ ...g.start, x: g.start.x + p.clientX - g.x, y: g.start.y + p.clientY - g.y });
    }
  };
  const onTouchEnd = (e) => {
    if (e.touches.length) return;
    gesture.current = null;
    setZoom((z) => (z.scale < 1.05 ? NO_ZOOM : z));
  };

  /** On phones this opens the share sheet ("Save Image" on iPhone); on computers it downloads. */
  async function save() {
    if (!file.url || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${file.url}?download=1`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const shared = new File([blob], file.name, { type: file.mime || blob.type || 'image/jpeg' });
      if (navigator.canShare?.({ files: [shared] })) {
        await navigator.share({ files: [shared] }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch {
      useStore.getState().showToast(t('Could not save the photo. Check your connection and try again.'), 'error');
    }
    setSaving(false);
  }

  return (
    <div className="viewer" onClick={() => zoom.scale === 1 && close()}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn light" onClick={close} aria-label="Back"><Icon name="back" /></button>
        <span className="ellipsis">{file.name}</span>
        {file.url && (
          <button className="icon-btn light" onClick={save} disabled={saving} aria-label="Download" title={t('Save')}>
            {saving ? <span className="spinner small" /> : <Icon name="download" />}
          </button>
        )}
      </div>
      <img
        src={file.localUrl || file.url}
        alt={file.name}
        className="viewer-image"
        draggable={false}
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
        onClick={(e) => e.stopPropagation()}
        // Touch screens also fire a double-click after a double-tap; the touch handler already zoomed.
        onDoubleClick={() => { if (Date.now() - lastTouch.current > 800) toggleZoom(); }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      />
    </div>
  );
}

export default function ChatView({ chatId }) {
  const t = useT();
  const chat = useStore((s) => s.chats[chatId]);
  const messages = useStore((s) => s.messages[chatId]);
  const hasMore = useStore((s) => s.hasMore[chatId]);
  const me = useStore((s) => s.me);
  const jumpTo = useStore((s) => s.jumpTo);
  const scroller = useRef();
  const atBottom = useRef(true);
  const prevInfo = useRef({ count: 0, firstId: null, height: 0 });
  const loadingOlder = useRef(false);
  const [highlight, setHighlight] = useState(null);
  const [searching, setSearching] = useState(false);
  const [showDown, setShowDown] = useState(false);
  const [viewer, setViewer] = useState(null);
  const [selection, setSelection] = useState(null); // Set of ids or null
  const [dragging, setDragging] = useState(false);
  const ctx = useContextMenu();

  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const jump = useCallback(async (id) => {
    let el = document.getElementById(`msg-${id}`);
    if (!el) {
      await useStore.getState().loadMessages(chatId, { around: id });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      el = document.getElementById(`msg-${id}`);
    }
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlight(id);
      setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1600);
    }
  }, [chatId]);

  // Initial position / jump from search.
  useEffect(() => {
    if (jumpTo && messages?.length) {
      jump(jumpTo);
      useStore.setState({ jumpTo: null });
    }
  }, [jumpTo, messages?.length, jump]);

  // Keep scroll anchored: stick to bottom for new messages, preserve position when older ones load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    const prev = prevInfo.current;
    const firstId = messages[0]?.id;
    if (prev.count === 0) scrollToBottom();
    else if (loadingOlder.current && firstId !== prev.firstId) {
      el.scrollTop += el.scrollHeight - prev.height;
      loadingOlder.current = false;
    } else if (atBottom.current || messages[messages.length - 1]?.senderId === me.id && messages.length > prev.count) {
      scrollToBottom(prev.count > 0);
    }
    prevInfo.current = { count: messages.length, firstId, height: el.scrollHeight };
  }, [messages, me.id]);

  // Mark as read while the newest messages are on screen.
  useEffect(() => {
    const tryRead = () => {
      if (document.visibilityState === 'visible' && atBottom.current) useStore.getState().markRead(chatId);
    };
    tryRead();
    document.addEventListener('visibilitychange', tryRead);
    window.addEventListener('focus', tryRead);
    return () => { document.removeEventListener('visibilitychange', tryRead); window.removeEventListener('focus', tryRead); };
  }, [chatId, chat?.lastMessage?.id]);

  const onScroll = async () => {
    const el = scroller.current;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 80;
    setShowDown(distance > 400);
    if (atBottom.current) useStore.getState().markRead(chatId);
    if (el.scrollTop < 300 && hasMore && !loadingOlder.current && messages?.length) {
      loadingOlder.current = true;
      prevInfo.current.height = el.scrollHeight;
      const firstReal = messages.find((m) => !m.pending);
      try {
        const older = await useStore.getState().loadMessages(chatId, { before: firstReal?.id });
        if (!older.length) loadingOlder.current = false;
      } catch { loadingOlder.current = false; }
    }
  };

  const actions = useMemo(() => ({
    reply: (m) => useStore.setState({ replyTo: m, editing: null }),
    react: (m, emoji) => api.post(`/messages/${m.id}/reactions`, { emoji }).catch((e) => useStore.getState().showToast(e, 'error')),
    open: (e, m) => {
      const s = useStore.getState();
      const c = s.chats[chatId];
      if (m.pending) {
        if (m.failed) ctx.open(e, [{ icon: 'trash', label: tr('Delete'), danger: true, onClick: () => s.discardPending(chatId, m.clientId) }]);
        return;
      }
      const mine = m.senderId === s.me.id;
      const canModerate = c.type === 'group' && ['owner', 'admin'].includes(c.myRole);
      const canPin = c.type === 'direct' || canModerate;
      const canPost = !(c.type === 'group' && c.onlyAdminsPost && !canModerate);
      const translation = s.translations[m.id];
      const items = [
        canPost && m.type !== 'call' && { icon: 'reply', label: tr('Reply'), onClick: () => actions.reply(m) },
        s.config.translation && m.body && (translation?.shown
          ? { icon: 'translate', label: tr('Show original'), onClick: () => s.hideTranslation(m.id) }
          : { icon: 'translate', label: tr('Translate'), onClick: () => s.translateMessage(m, 'auto') }),
        mine && ['text', 'file'].includes(m.type) && { icon: 'edit', label: tr('Edit'), onClick: () => useStore.setState({ editing: m, replyTo: null }) },
        m.body && { icon: 'copy', label: tr('Copy text'), onClick: () => navigator.clipboard?.writeText(m.body).then(() => s.showToast(tr('Copied to clipboard')), () => s.showToast(tr('Copy is not allowed here'), 'error')) },
        m.file && { icon: 'download', label: tr('Download'), onClick: () => { const a = document.createElement('a'); a.href = `${m.file.url}?download=1`; a.download = m.file.name; a.click(); } },
        m.type !== 'call' && { icon: 'forward', label: tr('Forward'), onClick: () => s.openModal({ type: 'forward', messageIds: [m.id] }) },
        mine && c.type === 'group' && !['system', 'call'].includes(m.type) && { icon: 'checks', label: tr('Seen by'), onClick: () => s.openModal({ type: 'seenBy', message: m }) },
        canPin && { icon: 'pin', label: tr('Pin'), onClick: () => api.post(`/messages/${m.id}/pin`).catch((err) => s.showToast(err, 'error')) },
        { icon: 'check', label: tr('Select'), onClick: () => setSelection(new Set([m.id])) },
        { icon: 'trash', label: tr('Delete'), danger: true, onClick: () => s.openModal({ type: 'delete', messages: [m], canEveryone: mine || canModerate }) },
      ].filter(Boolean);
      ctx.open(e, items, (close) => (
        <div className="quick-reactions">
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} onClick={() => { close(); actions.react(m, emoji); }}>{emoji}</button>
          ))}
        </div>
      ));
    },
  }), [chatId]);

  const toggleSelect = useCallback((m) => {
    setSelection((sel) => {
      const next = new Set(sel);
      if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
      return next.size ? next : null;
    });
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) window.dispatchEvent(new CustomEvent('composer-files', { detail: files }));
  };

  if (!chat) return <div className="empty-chat"><span className="pill">{t('Chat not available')}</span></div>;

  const list = messages || [];
  const canModerate = chat.type === 'group' && ['owner', 'admin'].includes(chat.myRole);
  const selectedMsgs = selection ? list.filter((m) => selection.has(m.id)) : [];

  return (
    <div className="chat-view" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop}>
      {selection ? (
        <header className="chat-header">
          <button className="icon-btn" onClick={() => setSelection(null)} aria-label="Cancel selection"><Icon name="close" /></button>
          <div className="chat-title grow">{t('selected', { n: selection.size })}</div>
          <button className="btn ghost" onClick={() => { useStore.getState().openModal({ type: 'forward', messageIds: [...selection] }); setSelection(null); }}>
            <Icon name="forward" size={18} /> <span className="hide-phone">{t('Forward')}</span>
          </button>
          <button className="btn ghost danger" onClick={() => {
            useStore.getState().openModal({ type: 'delete', messages: selectedMsgs, canEveryone: selectedMsgs.every((m) => m.senderId === me.id) || canModerate, onDone: () => setSelection(null) });
          }}><Icon name="trash" size={18} /> <span className="hide-phone">{t('Delete')}</span></button>
        </header>
      ) : searching ? <SearchBar chatId={chatId} onClose={() => setSearching(false)} onJump={jump} />
        : <ChatHeader chat={chat} onSearch={() => setSearching(true)} />}
      <GroupCallBar chatId={chatId} />
      <PinnedBar chatId={chatId} onJump={jump} />

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner">
          {!messages && <div className="center pad"><span className="spinner" /></div>}
          {messages && !hasMore && (
            <div className="service"><span className="pill">{chat.type === 'group' ? t('Group “{title}”', { title: chat.title }) : t('This is the beginning of your conversation')}</span></div>
          )}
          {list.map((m, i) => {
            const prev = list[i - 1];
            const next = list[i + 1];
            const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt);
            const sameAsPrev = prev && !newDay && prev.senderId === m.senderId && prev.type !== 'system';
            const sameAsNext = next && isSameDay(next.createdAt, m.createdAt) && next.senderId === m.senderId && next.type !== 'system';
            return (
              <Fragment key={m.pending ? m.clientId : m.id}>
                {newDay && <div className="service sticky"><span className="pill">{dayLabel(m.createdAt)}</span></div>}
                <Message m={m} chat={chat} showName={!sameAsPrev} showAvatar={!sameAsNext} onContext={actions} onJump={jump}
                  onOpenMedia={setViewer} highlighted={highlight === m.id} selecting={!!selection} selected={selection?.has(m.id)} onSelect={toggleSelect} />
              </Fragment>
            );
          })}
        </div>
      </div>

      {showDown && (
        <button className="scroll-down" onClick={() => scrollToBottom(true)} aria-label="Scroll to bottom">
          <Icon name="back" className="rot-270" />
          {chat.unread > 0 && <span className="badge">{chat.unread}</span>}
        </button>
      )}

      <Composer chat={chat} />
      {dragging && <div className="drop-zone"><div><Icon name="attach" size={40} /><p>{t('Drop files to send')}</p></div></div>}
      {viewer && <MediaViewer file={viewer} onClose={() => setViewer(null)} />}
      <ContextMenu {...ctx} />
    </div>
  );
}
