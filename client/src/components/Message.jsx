import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store.js';
import { AVATAR_COLORS, callText, duration, fileSize, linkify, systemText, timeOf } from '../lib/format.js';
import { detectLangClient, useT } from '../lib/i18n.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';

export function MessageStatus({ message, chat }) {
  if (message.failed) return <Icon name="alert" size={15} className="status failed" />;
  if (message.pending) return <Icon name="clock" size={14} className="status" />;
  if (message.id <= chat.othersReadId) return <Icon name="checks" size={16} className="status read" />;
  if (message.id <= chat.othersDeliveredId) return <Icon name="checks" size={16} className="status" />;
  return <Icon name="check" size={16} className="status" />;
}

function VoicePlayer({ file, mine }) {
  const t = useT();
  const audio = useRef();
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const bars = file.waveform?.length ? file.waveform : Array.from({ length: 40 }, (_, i) => 0.3 + 0.25 * Math.abs(Math.sin(i * 1.7)));

  useEffect(() => {
    const a = audio.current;
    const onTime = () => setProgress(a.duration && Number.isFinite(a.duration) ? a.currentTime / a.duration : a.currentTime / (file.duration || 1));
    const onEnd = () => { setPlaying(false); setProgress(0); };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onPause);
    a.addEventListener('play', onPlay);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('play', onPlay);
    };
  }, [file.duration]);

  const toggle = (e) => {
    e.stopPropagation();
    // Only one voice message plays at a time.
    document.querySelectorAll('audio').forEach((el) => el !== audio.current && !el.classList.contains('call-audio') && el.pause());
    if (audio.current.paused) audio.current.play().catch(() => {}); else audio.current.pause();
  };
  const seek = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    const a = audio.current;
    const total = Number.isFinite(a.duration) ? a.duration : file.duration;
    if (total) a.currentTime = frac * total;
  };

  return (
    <div className="voice">
      <button className={`voice-btn ${mine ? 'mine' : ''}`} onClick={toggle} aria-label={t('Voice message')}>
        <Icon name={playing ? 'pause' : 'play'} size={20} fill="currentColor" strokeWidth={0} />
      </button>
      <div className="voice-body">
        <div className="waveform" onClick={seek}>
          {bars.map((b, i) => (
            <span key={i} className={i / bars.length <= progress ? 'on' : ''} style={{ height: `${Math.max(12, b * 100)}%` }} />
          ))}
        </div>
        <span className="voice-time">{duration(playing || progress ? progress * (file.duration || 0) : file.duration)}</span>
      </div>
      <audio ref={audio} src={file.localUrl || file.url} preload="none" />
    </div>
  );
}

function UploadProgress({ progress = 0 }) {
  return (
    <span className="upload-progress">
      <span className="spinner" />
      <span>{Math.round(progress * 100)}%</span>
    </span>
  );
}

function Attachment({ file, mine, onOpenMedia }) {
  const t = useT();
  const src = file.localUrl || file.url;
  if (file.kind === 'image') {
    const ratio = file.width && file.height ? file.height / file.width : 0.75;
    return (
      <button className="media" onClick={(e) => { e.stopPropagation(); if (!file.uploading) onOpenMedia(file); }} style={{ aspectRatio: `${1 / Math.min(Math.max(ratio, 0.4), 1.6)}` }}>
        <img src={src} alt={file.name} loading="lazy" />
        {file.uploading && <UploadProgress progress={file.progress} />}
      </button>
    );
  }
  if (file.kind === 'video') {
    return <div className="media video"><video src={src} controls={!file.uploading} preload="metadata" playsInline />{file.uploading && <UploadProgress progress={file.progress} />}</div>;
  }
  if (file.kind === 'voice') return <VoicePlayer file={file} mine={mine} />;
  if (file.kind === 'audio') {
    return (
      <div className="doc">
        <div className="doc-icon"><Icon name="play" size={18} /></div>
        <div className="doc-body">
          <div className="doc-name">{file.name}</div>
          <audio src={src} controls preload="none" className="inline-audio" />
        </div>
      </div>
    );
  }
  return (
    <a className="doc" href={file.url ? `${file.url}?download=1` : undefined} target="_blank" rel="noreferrer" download={file.name} onClick={(e) => e.stopPropagation()}>
      <div className="doc-icon"><Icon name={file.uploading ? 'clock' : 'download'} size={20} /></div>
      <div className="doc-body">
        <div className="doc-name">{file.name}</div>
        <div className="doc-meta">
          {file.uploading
            ? t('Uploading… {p}%', { p: Math.round((file.progress || 0) * 100) })
            : `${fileSize(file.size)} · ${file.name.split('.').pop()?.toUpperCase().slice(0, 5) || 'FILE'}`}
        </div>
      </div>
      {file.mime === 'application/pdf' && file.url && (
        <button className="doc-open" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(file.url, '_blank', 'noopener'); }}>{t('Open')}</button>
      )}
    </a>
  );
}

function ReplyQuote({ reply, onJump }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const name = users[reply.senderId]?.displayName || '…';
  const text = reply.deleted ? t('Deleted message')
    : reply.type === 'voice' ? `🎤 ${t('Voice message')}`
      : reply.body || (reply.fileKind === 'image' ? `🖼 ${t('Photo')}` : reply.fileKind === 'video' ? `🎬 ${t('Video')}` : reply.fileName ? `📎 ${reply.fileName}` : '');
  return (
    <button className="reply-quote" onClick={(e) => { e.stopPropagation(); onJump(reply.id); }}>
      <span className="reply-name" style={{ color: AVATAR_COLORS[(users[reply.senderId]?.avatarColor || 0) % 8] }}>{name}</span>
      <span className="reply-text">{text}</span>
    </button>
  );
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

/** Highlights @username for people the app knows; anything else stays plain text. */
function withMentions(text, keyBase) {
  const { users, me } = useStore.getState();
  const byName = new Map(Object.values(users).filter((u) => u.username).map((u) => [u.username.toLowerCase(), u]));
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/(^|[^\w@])@([a-zA-Z0-9._-]{3,32})/g)) {
    const name = m[2].replace(/[.-]+$/, '');
    const user = byName.get(name.toLowerCase());
    if (!user) continue;
    const start = m.index + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    out.push(<span key={`${keyBase}-${start}`} className={`mention ${user.id === me?.id ? 'me' : ''}`} title={user.displayName}>@{name}</span>);
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const renderText = (text) => linkify(text).flatMap((p, i) => (typeof p === 'string'
  ? withMentions(p, i)
  : [<a key={i} href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{p.href}</a>]));

function Translation({ m }) {
  const t = useT();
  const tr = useStore((s) => s.translations[m.id]);
  if (!tr?.shown) return null;
  if (tr.status === 'loading') return <div className="translation muted"><span className="spinner small" /> {t('Translating…')}</div>;
  if (tr.status !== 'done') return null;
  return (
    <div className="translation">
      <div className="translation-label">
        <Icon name="translate" size={14} /> {t('Translated from {lang}', { lang: t(tr.source === 'ru' ? 'Russian' : 'English') })}
        <button onClick={(e) => { e.stopPropagation(); useStore.getState().hideTranslation(m.id); }}>{t('Show original')}</button>
      </div>
      <div className="text">{renderText(tr.text)}</div>
    </div>
  );
}

function Message({ m, chat, showName, showAvatar, onContext, onJump, onOpenMedia, highlighted, selected, selecting, onSelect }) {
  const t = useT();
  useStore((s) => s.lang); // re-render on language change
  const me = useStore((s) => s.me);
  const sender = useStore((s) => s.users[m.senderId]);
  const translationEnabled = useStore((s) => s.config.translation);
  const longPress = useRef();
  const pressStart = useRef({ x: 0, y: 0 });
  const mine = m.senderId === me.id;

  // Live translation: auto-translate incoming text into the language chosen for this chat.
  const auto = chat.autoTranslate;
  useEffect(() => {
    if (!auto || !translationEnabled || mine || m.pending || !m.body || m.type === 'system' || m.type === 'call') return;
    if (detectLangClient(m.body) === auto) return;
    useStore.getState().translateMessage(m, auto, { silent: true });
  }, [auto, translationEnabled, m.id, m.body]);

  if (m.type === 'system') {
    return <div className="service"><span className="pill">{systemText(m, useStore.getState().users)}</span></div>;
  }

  const onlyMedia = m.file && ['image', 'video'].includes(m.file.kind) && !m.body && !m.replyTo && !m.forwardedFrom;

  const handlers = selecting
    ? { onClick: () => onSelect(m) }
    : {
      onContextMenu: (e) => { e.preventDefault(); onContext.open(e, m); },
      // On phones a tap opens the message menu, like Telegram. Links, media and buttons keep their own taps.
      onClick: (e) => {
        if (!isTouch() || e.target.closest('a, button, audio, video, input, .reaction')) return;
        onContext.open(e, m);
      },
      onDoubleClick: () => !m.pending && onContext.reply(m),
      onTouchStart: (e) => {
        const p = e.touches[0];
        pressStart.current = { x: p.clientX, y: p.clientY };
        longPress.current = setTimeout(() => { navigator.vibrate?.(10); onContext.open({ clientX: p.clientX, clientY: p.clientY }, m); }, 450);
      },
      onTouchEnd: () => clearTimeout(longPress.current),
      onTouchCancel: () => clearTimeout(longPress.current),
      // A finger is never perfectly still, so only a real scroll cancels the press.
      onTouchMove: (e) => {
        const p = e.touches[0];
        if (Math.hypot(p.clientX - pressStart.current.x, p.clientY - pressStart.current.y) > 10) clearTimeout(longPress.current);
      },
    };

  return (
    <div id={`msg-${m.id}`} className={`msg-row ${mine ? 'mine' : ''} ${highlighted ? 'highlight' : ''} ${selected ? 'selected' : ''}`} {...handlers}>
      {selecting && <span className={`select-dot ${selected ? 'on' : ''}`}><Icon name="check" size={14} strokeWidth={3} /></span>}
      {chat.type === 'group' && !mine && (
        <div className="msg-avatar">{showAvatar && <Avatar name={sender?.displayName} color={sender?.avatarColor} src={sender?.avatarUrl} size={34} />}</div>
      )}
      <div className={`bubble ${mine ? 'out' : 'in'} ${onlyMedia ? 'media-only' : ''} ${showAvatar ? 'tail' : ''} ${m.type === 'call' ? 'call' : ''}`}>
        {showName && !mine && chat.type === 'group' && (
          <div className="sender-name" style={{ color: AVATAR_COLORS[(sender?.avatarColor || 0) % 8] }}>{sender?.displayName || '…'}</div>
        )}
        {m.forwardedFrom && <div className="forwarded">{t('Forwarded from')} <b>{m.forwardedFrom.name}</b></div>}
        {m.replyTo && <ReplyQuote reply={m.replyTo} onJump={onJump} />}
        {m.file && <Attachment file={m.file} mine={mine} onOpenMedia={onOpenMedia} />}
        {m.type === 'call' && (
          <div className="call-msg">
            <Icon name={m.meta?.video ? 'video' : 'phone'} size={20} />
            <div>
              <div className="strong">{m.meta?.group ? t(m.meta.video ? 'Group video call' : 'Group call') : `${t(mine ? 'Outgoing' : 'Incoming')} ${t(m.meta?.video ? 'video call' : 'call')}`}</div>
              <div className={`small ${m.meta?.status === 'completed' ? 'muted' : 'danger-text'}`}>{callText(m.meta).replace(/^\S+\s/, '')}</div>
            </div>
          </div>
        )}
        {m.body && <div className="text">{renderText(m.body)}</div>}
        <Translation m={m} />
        <span className="meta">
          {m.editedAt && <span className="edited">{t('edited')}</span>}
          {timeOf(m.createdAt)}
          {mine && m.type !== 'call' && <MessageStatus message={m} chat={chat} />}
        </span>
        {m.failed && (
          <div className="failed-actions">
            <button onClick={(e) => { e.stopPropagation(); useStore.getState().retryMessage(chat.id, m); }}>{t('Retry')}</button>
            <button onClick={(e) => { e.stopPropagation(); useStore.getState().discardPending(chat.id, m.clientId); }}>{t('Delete')}</button>
          </div>
        )}
        {m.reactions?.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} className={`reaction ${r.userIds.includes(me.id) ? 'mine' : ''}`} onClick={(e) => { e.stopPropagation(); onContext.react(m, r.emoji); }}
                title={r.userIds.map((id) => useStore.getState().users[id]?.displayName).join(', ')}>
                {r.emoji} <span>{r.userIds.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(Message);
