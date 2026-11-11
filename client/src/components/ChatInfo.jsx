import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { fileSize, lastSeen } from '../lib/format.js';
import { startCall } from '../lib/call.js';
import { locale, useT } from '../lib/i18n.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';

export default function ChatInfo({ chatId }) {
  const t = useT();
  const chat = useStore((s) => s.chats[chatId]);
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.online);
  const translationEnabled = useStore((s) => s.config.translation);
  const [details, setDetails] = useState(null);
  const [media, setMedia] = useState([]);
  const [tab, setTab] = useState('media');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});

  const load = useCallback(() => {
    api.get(`/chats/${chatId}`).then((r) => {
      setDetails(r.chat);
      useStore.getState().mergeUsers(r.chat.members);
    }).catch(() => {});
    api.get(`/chats/${chatId}/media`).then((r) => setMedia(r.messages)).catch(() => {});
  }, [chatId]);

  useEffect(() => {
    load();
    const h = (e) => e.detail === chatId && load();
    window.addEventListener('members-changed', h);
    return () => window.removeEventListener('members-changed', h);
  }, [chatId, load, chat?.memberCount, chat?.title]);

  if (!chat) return null;
  const close = () => useStore.setState({ infoOpen: false });
  const isGroup = chat.type === 'group';
  const amAdmin = isGroup && (['owner', 'admin'].includes(chat.myRole) || me.role === 'admin');
  const amOwner = chat.myRole === 'owner' || me.role === 'admin';
  const s = useStore.getState();
  const err = (e) => s.showToast(e, 'error');
  const date = (iso) => new Date(iso).toLocaleDateString(locale());

  const setting = (patch) => api.patch(`/chats/${chatId}/settings`, patch).catch(err);

  async function saveGroup() {
    try {
      await api.patch(`/chats/${chatId}`, form);
      setEditing(false);
      load();
    } catch (e) { err(e); }
  }

  function memberMenu(m) {
    if (m.id === me.id || !amAdmin) return;
    s.openModal({ type: 'memberActions', member: m, chat, amOwner, onChanged: load });
  }

  const images = media.filter((m) => ['image', 'video'].includes(m.file?.kind));
  const docs = media.filter((m) => ['document', 'audio'].includes(m.file?.kind));
  const voices = media.filter((m) => m.file?.kind === 'voice');

  return (
    <aside className="info-pane">
      <header className="info-header">
        <button className="icon-btn" onClick={close} aria-label={t('Back')}><Icon name="close" /></button>
        <div className="strong">{t(isGroup ? 'Group info' : 'User info')}</div>
        {isGroup && amAdmin && !editing && (
          <button className="icon-btn" onClick={() => { setForm({ title: chat.title, description: chat.description, onlyAdminsPost: chat.onlyAdminsPost, membersCanAdd: chat.membersCanAdd }); setEditing(true); }} aria-label={t('Edit')}>
            <Icon name="edit" />
          </button>
        )}
      </header>
      <div className="info-scroll">
        <div className="info-hero">
          <Avatar name={chat.title} color={chat.avatarColor} src={chat.avatarUrl} size={96} group={isGroup} />
          <div className="info-title">{chat.title}</div>
          <div className="muted small">
            {isGroup ? t('members', { n: chat.memberCount }) : lastSeen(useStore.getState().users[chat.peer?.id], online.has(chat.peer?.id))}
          </div>
        </div>

        {editing ? (
          <div className="stack pad">
            <label className="field"><span>{t('Group name')}</span><input value={form.title} maxLength={128} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field"><span>{t('Description')}</span><textarea rows={3} value={form.description} maxLength={1000} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={form.onlyAdminsPost} onChange={(e) => setForm({ ...form, onlyAdminsPost: e.target.checked })} /> {t('Only admins can send messages')}</label>
            <label className="check"><input type="checkbox" checked={form.membersCanAdd} onChange={(e) => setForm({ ...form, membersCanAdd: e.target.checked })} /> {t('Members can add people')}</label>
            <div className="row gap">
              <button className="btn primary" onClick={saveGroup}>{t('Save')}</button>
              <button className="btn ghost" onClick={() => setEditing(false)}>{t('Cancel')}</button>
            </div>
          </div>
        ) : (
          <div className="info-list">
            {!isGroup && chat.peer && (
              <>
                <div className="info-row"><Icon name="user" /><div><div>@{chat.peer.username}</div><div className="muted small">{t('Username')}</div></div></div>
                {chat.peer.title && <div className="info-row"><Icon name="info" /><div><div>{chat.peer.title}</div><div className="muted small">{t('Position')}</div></div></div>}
                <div className="info-actions">
                  <button className="btn ghost" onClick={() => startCall(chat, false)}><Icon name="phone" size={18} /> {t('Call')}</button>
                  <button className="btn ghost" onClick={() => startCall(chat, true)}><Icon name="video" size={18} /> {t('Video')}</button>
                </div>
              </>
            )}
            {isGroup && chat.description && <div className="info-row"><Icon name="info" /><div className="pre-wrap">{chat.description}</div></div>}
            <label className="info-row toggle">
              <Icon name={chat.muted ? 'bellOff' : 'bell'} />
              <span className="grow">{t('Notifications')}</span>
              <input type="checkbox" className="switch" checked={!chat.muted} onChange={(e) => setting({ muted: !e.target.checked })} />
            </label>
            {translationEnabled && (
              <div className="info-row">
                <Icon name="translate" />
                <span className="grow">{t('Auto-translate incoming messages')}</span>
                <div className="segmented">
                  {[[null, 'Off'], ['en', 'EN'], ['ru', 'RU']].map(([v, label]) => (
                    <button key={label} className={(chat.autoTranslate ?? null) === v ? 'on' : ''} title={v ? t(v === 'en' ? 'To English' : 'To Russian') : t('Off')}
                      onClick={() => setting({ autoTranslate: v })}>{v ? label : t('Off')}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {isGroup && details && (
          <div className="info-section">
            <div className="section-title row">
              <span>{t('members', { n: details.members.length })}</span>
              {(amAdmin || chat.membersCanAdd) && (
                <button className="btn ghost small" onClick={() => s.openModal({ type: 'addMembers', chat, existing: details.members.map((m) => m.id), onDone: load })}>
                  <Icon name="plus" size={16} /> {t('Add')}
                </button>
              )}
            </div>
            {details.members.map((m) => (
              <button key={m.id} className="member-row" onClick={() => memberMenu(m)}>
                <Avatar name={m.displayName} color={m.avatarColor} src={m.avatarUrl} size={40} online={online.has(m.id)} />
                <div className="grow left">
                  <div>{m.displayName}{m.id === me.id && <span className="muted"> {t('(you)')}</span>}</div>
                  <div className={`small ${online.has(m.id) ? 'accent' : 'muted'}`}>{lastSeen(m, online.has(m.id))}</div>
                </div>
                {m.memberRole !== 'member' && <span className="role-tag">{t(m.memberRole)}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="info-section">
          <div className="tabs">
            <button className={tab === 'media' ? 'on' : ''} onClick={() => setTab('media')}>{t('Media')} ({images.length})</button>
            <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>{t('Files')} ({docs.length})</button>
            <button className={tab === 'voice' ? 'on' : ''} onClick={() => setTab('voice')}>{t('Voice')} ({voices.length})</button>
          </div>
          {tab === 'media' && (
            <div className="media-grid">
              {images.map((m) => (
                <button key={m.id} onClick={() => s.openChat(chatId, { jumpTo: m.id })}>
                  {m.file.kind === 'image' ? <img src={m.file.url} alt="" loading="lazy" /> : <div className="video-thumb"><Icon name="play" /></div>}
                </button>
              ))}
            </div>
          )}
          {tab === 'files' && docs.map((m) => (
            <a key={m.id} className="doc file-row" href={`${m.file.url}?download=1`} download={m.file.name}>
              <div className="doc-icon"><Icon name="file" size={20} /></div>
              <div className="doc-body"><div className="doc-name">{m.file.name}</div><div className="doc-meta">{fileSize(m.file.size)} · {date(m.createdAt)}</div></div>
            </a>
          ))}
          {tab === 'voice' && voices.map((m) => (
            <button key={m.id} className="member-row" onClick={() => s.openChat(chatId, { jumpTo: m.id })}>
              <Icon name="mic" /> <span className="grow left">{useStore.getState().users[m.senderId]?.displayName}</span>
              <span className="muted small">{date(m.createdAt)}</span>
            </button>
          ))}
        </div>

        {isGroup && (
          <div className="info-section">
            <button className="danger-row" onClick={() => s.openModal({
              type: 'confirm', title: t('Leave group'), text: t('Leave “{title}”?', { title: chat.title }), confirm: t('Leave'), danger: true,
              onConfirm: () => api.del(`/chats/${chatId}/members/${me.id}`).then(close),
            })}><Icon name="logout" /> {t('Leave group')}</button>
          </div>
        )}
      </div>
    </aside>
  );
}
