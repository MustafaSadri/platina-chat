import { useEffect, useMemo, useState, useRef } from 'react';
import * as api from '../lib/api.js';
import { cropToJpeg, dayLabel, timeOf } from '../lib/format.js';
import { useStore } from '../lib/store.js';
import { disableNotifications, enableNotifications, isIos, notificationStatus, unsubscribePush } from '../lib/notify.js';
import { disconnectSocket } from '../lib/socket.js';
import { locale, useT } from '../lib/i18n.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';
import { ChangePassword, LanguageSwitch } from './Auth.jsx';
import AdminPanel from './Admin.jsx';

export function Modal({ title, onClose, children, wide = false, footer = null }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <header className="modal-header">
          <div className="strong">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function UserPicker({ selected, onToggle, exclude = [], single = false, onPick }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.online);
  const [q, setQ] = useState('');
  const list = useMemo(() => Object.values(users)
    .filter((u) => u.id !== me.id && u.status === 'active' && !exclude.includes(u.id))
    .filter((u) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username?.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.displayName.localeCompare(b.displayName)), [users, q, exclude, me.id]);
  return (
    <div className="picker">
      <div className="search-box boxed"><Icon name="search" size={18} /><input autoFocus placeholder={t('Search people')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="picker-list">
        {list.map((u) => (
          <button key={u.id} className="member-row" onClick={() => (single ? onPick(u) : onToggle(u.id))}>
            {!single && <span className={`select-dot ${selected.includes(u.id) ? 'on' : ''}`}><Icon name="check" size={14} strokeWidth={3} /></span>}
            <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={40} online={online.has(u.id)} />
            <div className="grow left">
              <div>{u.displayName}</div>
              <div className="muted small">@{u.username}{u.title ? ` · ${u.title}` : ''}</div>
            </div>
          </button>
        ))}
        {!list.length && <div className="muted pad center">{t('No people found')}</div>}
      </div>
    </div>
  );
}

function NewChat({ close }) {
  const t = useT();
  const me = useStore((s) => s.me);
  async function pick(u) {
    try {
      const { chat } = await api.post('/chats/direct', { userId: u.id });
      useStore.getState().upsertChat(chat);
      useStore.getState().openChat(chat.id);
      close();
    } catch (err) { useStore.getState().showToast(err, 'error'); }
  }
  return (
    <Modal title={t('New message')} onClose={close}>
      {me.canCreateGroups && (
        <button className="member-row accent" onClick={() => useStore.getState().openModal({ type: 'newGroup' })}>
          <div className="avatar accent-bg" style={{ width: 40, height: 40 }}><Icon name="users" size={20} /></div>
          <div className="grow left strong">{t('New group')}</div>
        </button>
      )}
      <UserPicker single onPick={pick} />
    </Modal>
  );
}

function NewGroup({ close }) {
  const t = useT();
  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  async function create() {
    setBusy(true);
    try {
      const { chat } = await api.post('/chats/group', { title, memberIds: selected });
      useStore.getState().upsertChat(chat);
      useStore.getState().openChat(chat.id);
      close();
    } catch (err) { useStore.getState().showToast(err, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={step === 1 ? `${t('Add members')}${selected.length ? ` (${selected.length})` : ''}` : t('New group')} onClose={close}
      footer={step === 1
        ? <button className="btn primary" onClick={() => setStep(2)}>{t('Next')}</button>
        : <><button className="btn ghost" onClick={() => setStep(1)}>{t('Back')}</button><button className="btn primary" disabled={!title.trim() || busy} onClick={create}>{t('Create')}</button></>}>
      {step === 1 ? <UserPicker selected={selected} onToggle={toggle} /> : (
        <div className="stack">
          <label className="field"><span>{t('Group name')}</span><input autoFocus value={title} maxLength={128} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && create()} /></label>
          <p className="muted small">{t('members selected. You will be the group owner.', { n: selected.length })}</p>
        </div>
      )}
    </Modal>
  );
}

function AddMembers({ modal, close }) {
  const t = useT();
  const [selected, setSelected] = useState([]);
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  async function add() {
    try {
      await api.post(`/chats/${modal.chat.id}/members`, { userIds: selected });
      modal.onDone?.();
      close();
    } catch (err) { useStore.getState().showToast(err, 'error'); }
  }
  return (
    <Modal title={t('Add members')} onClose={close} footer={<button className="btn primary" disabled={!selected.length} onClick={add}>{t('Add')} {selected.length || ''}</button>}>
      <UserPicker selected={selected} onToggle={toggle} exclude={modal.existing} />
    </Modal>
  );
}

function MemberActions({ modal, close }) {
  const t = useT();
  const { member, chat, amOwner } = modal;
  const s = useStore.getState();
  const run = (p) => p.then(() => { modal.onChanged?.(); close(); }).catch((err) => s.showToast(err, 'error'));
  async function message() {
    const { chat: c } = await api.post('/chats/direct', { userId: member.id });
    s.upsertChat(c);
    s.openChat(c.id);
    close();
  }
  return (
    <Modal title={member.displayName} onClose={close}>
      <div className="stack">
        <button className="member-row" onClick={message}><Icon name="send" /> {t('Send message')}</button>
        {amOwner && member.memberRole !== 'owner' && (
          <button className="member-row" onClick={() => run(api.patch(`/chats/${chat.id}/members/${member.id}`, { role: member.memberRole === 'admin' ? 'member' : 'admin' }))}>
            <Icon name="shield" /> {t(member.memberRole === 'admin' ? 'Remove admin rights' : 'Make group admin')}
          </button>
        )}
        {member.memberRole !== 'owner' && (
          <button className="member-row danger-text" onClick={() => run(api.del(`/chats/${chat.id}/members/${member.id}`))}>
            <Icon name="trash" /> {t('Remove from group')}
          </button>
        )}
      </div>
    </Modal>
  );
}

function Forward({ modal, close }) {
  const t = useT();
  useStore((s) => s.chats);
  const [q, setQ] = useState('');
  const list = useStore.getState().sortedChats().filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  async function send(chat) {
    try {
      await api.post('/messages/forward', { messageIds: modal.messageIds, toChatIds: [chat.id] });
      useStore.getState().openChat(chat.id);
      close();
    } catch (err) { useStore.getState().showToast(err, 'error'); }
  }
  return (
    <Modal title={t('Forward to…')} onClose={close}>
      <div className="search-box boxed"><Icon name="search" size={18} /><input autoFocus placeholder={t('Search chats')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="picker-list">
        {list.map((c) => (
          <button key={c.id} className="member-row" onClick={() => send(c)}>
            <Avatar name={c.title} color={c.avatarColor} src={c.avatarUrl} size={40} group={c.type === 'group'} />
            <div className="grow left">{c.title}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function DeleteMessages({ modal, close }) {
  const t = useT();
  const n = modal.messages.length;
  async function go(everyone) {
    const s = useStore.getState();
    for (const m of modal.messages) {
      try {
        await api.del(`/messages/${m.id}${everyone ? '?forEveryone=1' : ''}`);
      } catch (err) { s.showToast(err, 'error'); break; }
    }
    modal.onDone?.();
    close();
  }
  return (
    <Modal title={n > 1 ? t('Delete {n} messages', { n }) : t('Delete message')} onClose={close}>
      <p>{t(n > 1 ? 'Are you sure you want to delete these messages?' : 'Are you sure you want to delete this message?')}</p>
      <div className="delete-choices">
        {modal.canEveryone && <button className="btn danger block" onClick={() => go(true)}>{t('Delete for everyone')}</button>}
        <button className={`btn block ${modal.canEveryone ? 'ghost danger' : 'danger'}`} onClick={() => go(false)}>{t('Delete for me')}</button>
        <button className="btn ghost block" onClick={close}>{t('Cancel')}</button>
      </div>
      <p className="muted small">{t('Deleted messages are hidden from the chat. Your organisation may retain a copy according to its retention policy.')}</p>
    </Modal>
  );
}

function Confirm({ modal, close }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={modal.title} onClose={close} footer={<>
      <button className="btn ghost" onClick={close}>{t('Cancel')}</button>
      <button className={`btn ${modal.danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => {
        setBusy(true);
        try { await modal.onConfirm(); close(); } catch (err) { useStore.getState().showToast(err, 'error'); setBusy(false); }
      }}>{modal.confirm || t('OK')}</button>
    </>}>
      <p>{modal.text}</p>
    </Modal>
  );
}

function AvatarPicker({ me }) {
  const t = useT();
  const input = useRef();
  const [busy, setBusy] = useState(false);
  const save = async (work) => {
    setBusy(true);
    try {
      const { user } = await work();
      useStore.getState().setMe(user);
    } catch (err) { useStore.getState().showToast(err, 'error'); }
    setBusy(false);
  };
  const choose = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    save(async () => {
      const fd = new FormData();
      fd.append('file', await cropToJpeg(file), 'avatar.jpg');
      return api.api('POST', '/profile/avatar', fd);
    });
  };
  return (
    <div className="avatar-picker">
      <button className="avatar-edit" onClick={() => input.current.click()} disabled={busy} aria-label={t('Change profile photo')}>
        <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={72} />
        <span className="avatar-edit-badge">{busy ? <span className="spinner small" /> : <Icon name="edit" size={13} />}</span>
      </button>
      <input ref={input} type="file" accept="image/*" hidden onChange={choose} />
      {me.avatarUrl && <button className="link-btn small" disabled={busy} onClick={() => save(() => api.del('/profile/avatar'))}>{t('Remove photo')}</button>}
    </div>
  );
}

function DisplayName({ me }) {
  const t = useT();
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  if (draft === null) {
    return (
      <button className="name-edit" onClick={() => setDraft(me.displayName)} aria-label={t('Change display name')}>
        <span className="info-title">{me.displayName}</span> <Icon name="edit" size={15} className="muted-icon" />
      </button>
    );
  }
  async function save(e) {
    e.preventDefault();
    const displayName = draft.trim();
    if (!displayName) return;
    if (displayName !== me.displayName) {
      setBusy(true);
      try {
        const { user } = await api.patch('/profile', { displayName });
        useStore.getState().setMe(user);
      } catch (err) {
        useStore.getState().showToast(err, 'error');
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setDraft(null);
  }
  return (
    <form className="name-form" onSubmit={save}>
      <input autoFocus required maxLength={64} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t('Display name')} />
      <button className="btn primary small" disabled={busy}>{t('Save')}</button>
      <button type="button" className="btn ghost small" onClick={() => setDraft(null)}>{t('Cancel')}</button>
    </form>
  );
}

function NotificationSetting() {
  const t = useT();
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);
  const toast = (...args) => useStore.getState().showToast(...args);
  const refresh = () => notificationStatus().catch(() => 'off').then(setStatus);
  useEffect(() => { refresh(); }, []);

  const on = status === 'on' || status === 'local';
  const locked = ['loading', 'blocked', 'install', 'unsupported'].includes(status);
  const label = { on: 'On', local: 'On', off: 'Off', blocked: 'Blocked', install: 'Off', unsupported: 'Not supported', loading: '…' }[status];
  const help = {
    on: isIos() ? 'To hear alerts, allow Sounds for this app in iPhone Settings → Notifications.' : null,
    local: 'Notifications only appear while the app is open.',
    blocked: isIos() ? 'Notifications are blocked. Turn them on in iPhone Settings → Notifications.' : 'Notifications are blocked. Allow them in your browser’s site settings.',
    install: 'On iPhone, add this app to your Home Screen and open it from there to turn on notifications.',
    unsupported: 'This browser does not support notifications.',
  }[status];

  async function toggle() {
    setBusy(true);
    try {
      if (on) await disableNotifications();
      else await enableNotifications();
    } catch (err) { toast(err, 'error'); }
    await refresh();
    setBusy(false);
  }

  async function sendTest() {
    try {
      const { sent } = await api.post('/push/test');
      if (sent) toast(t('Test sent. Leave the app to see it.'));
      else toast(t('The test could not be delivered. Turn notifications off and on, then try again.'), 'error');
    } catch (err) { toast(err, 'error'); }
  }

  return (
    <>
      <label className="member-row static wrap">
        <Icon name="bell" />
        <span className="grow left">{t('Notifications')}</span>
        <span className={on ? 'accent small strong' : 'muted small'}>{t(label)}</span>
        <input type="checkbox" role="switch" className="switch" aria-label={t('Notifications')} checked={on} disabled={locked || busy} onChange={toggle} />
      </label>
      {help && <p className="muted small pad">{t(help)}</p>}
      {status === 'on' && <button className="member-row" onClick={sendTest}><Icon name="bell" /><span className="grow left">{t('Send a test notification')}</span></button>}
    </>
  );
}

function Settings({ close }) {
  const t = useT();
  const me = useStore((s) => s.me);
  const theme = useStore((s) => s.theme);
  const translationEnabled = useStore((s) => s.config.translation);
  const [section, setSection] = useState(null);
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    if (section === 'sessions') api.get('/auth/sessions').then((r) => setSessions(r.sessions)).catch(() => {});
  }, [section]);

  async function logout() {
    await unsubscribePush();
    await api.post('/auth/logout').catch(() => {});
    disconnectSocket();
    useStore.setState({ me: null, booted: false, chats: {}, messages: {}, activeChatId: null, modal: null, translations: {} });
  }

  if (section === 'password') {
    return <Modal title={t('Change password')} onClose={() => setSection(null)}><ChangePassword onDone={() => setSection(null)} /></Modal>;
  }
  if (section === 'sessions') {
    return (
      <Modal title={t('Active sessions')} onClose={() => setSection(null)}>
        {sessions.map((s) => (
          <div key={s.id} className="member-row static">
            <Icon name="devices" />
            <div className="grow left min0">
              <div className="ellipsis">{s.userAgent.replace(/\(.*?\)/g, '').slice(0, 60) || t('Unknown device')}{s.current && <span className="accent"> · {t('this device')}</span>}</div>
              <div className="muted small">{s.ip} · {t('last active {date}', { date: new Date(s.lastUsedAt).toLocaleString(locale()) })}</div>
            </div>
            {!s.current && <button className="btn ghost small danger" onClick={() => api.del(`/auth/sessions/${s.id}`).then(() => setSessions((x) => x.filter((y) => y.id !== s.id)))}>{t('End')}</button>}
          </div>
        ))}
      </Modal>
    );
  }
  return (
    <Modal title={t('Settings')} onClose={close}>
      <div className="settings-me">
        <AvatarPicker me={me} />
        <div>
          <DisplayName me={me} />
          <div className="muted">@{me.username}{me.title ? ` · ${me.title}` : ''}</div>
          {me.role === 'admin' && <span className="role-tag">{t('administrator')}</span>}
        </div>
      </div>
      <div className="settings-list">
        <div className="member-row static wrap">
          <Icon name="globe" />
          <span className="grow left">{t('Language')}</span>
          <LanguageSwitch />
        </div>
        <div className="member-row static wrap">
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
          <span className="grow left">{t('Theme')}</span>
          <div className="segmented">
            {['light', 'dark', 'system'].map((th) => (
              <button key={th} className={theme === th ? 'on' : ''} onClick={() => useStore.getState().setTheme(th)}>{t(th[0].toUpperCase() + th.slice(1))}</button>
            ))}
          </div>
        </div>
        <NotificationSetting />
        <button className="member-row" onClick={() => setSection('password')}><Icon name="key" /><span className="grow left">{t('Change password')}</span></button>
        <button className="member-row" onClick={() => setSection('sessions')}><Icon name="devices" /><span className="grow left">{t('Active sessions')}</span></button>
        <button className="member-row danger-text" onClick={logout}><Icon name="logout" /><span className="grow left">{t('Sign out')}</span></button>
      </div>
      <p className="muted small pad">
        {t('Messages are encrypted in transit (HTTPS/WSS) and stored on your organisation’s servers. This app does not use end-to-end encryption.')}
        {translationEnabled && <> {t('Message translation sends the message text to an external translation service configured by your administrator.')}</>}
      </p>
    </Modal>
  );
}

function Compose({ close }) {
  const t = useT();
  return (
    <Modal title={t('New')} onClose={close}>
      <button className="member-row" onClick={() => useStore.getState().openModal({ type: 'newChat' })}><Icon name="user" /><span className="grow left">{t('New message')}</span></button>
      <button className="member-row" onClick={() => useStore.getState().openModal({ type: 'newGroup' })}><Icon name="users" /><span className="grow left">{t('New group')}</span></button>
    </Modal>
  );
}

function SeenBy({ modal, close }) {
  const t = useT();
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get(`/messages/${modal.message.id}/reads`).then(setData).catch((err) => { useStore.getState().showToast(err, 'error'); close(); });
  }, [modal.message.id]);
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? timeOf(iso) : `${dayLabel(iso)}, ${timeOf(iso)}`;
  };
  return (
    <Modal title={t('Seen by')} onClose={close}>
      {!data && <div className="center pad"><span className="spinner" /></div>}
      {data && !data.read.length && <p className="muted">{t('Nobody has read this message yet.')}</p>}
      {data?.read.map(({ user, readAt }) => (
        <div key={user.id} className="member-row static">
          <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={40} />
          <span className="grow left ellipsis">{user.displayName}</span>
          <span className="muted small nowrap"><Icon name="checks" size={14} /> {when(readAt)}</span>
        </div>
      ))}
      {data?.unread.length > 0 && (
        <p className="muted small pad">{t('Not read yet: {names}', { names: data.unread.map((u) => u.displayName).join(', ') })}</p>
      )}
    </Modal>
  );
}

export default function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  const close = () => useStore.getState().closeModal();
  const C = {
    newChat: NewChat, newGroup: NewGroup, addMembers: AddMembers, memberActions: MemberActions, forward: Forward,
    delete: DeleteMessages, seenBy: SeenBy, confirm: Confirm, settings: Settings, compose: Compose, admin: AdminPanel,
  }[modal.type];
  return C ? <C modal={modal} close={close} /> : null;
}
