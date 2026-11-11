import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { locale, t as tr, useT } from '../lib/i18n.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';
import { Modal, UserPicker } from './Modals.jsx';

const toastErr = (err) => useStore.getState().showToast(err, 'error');

function TempPassword({ username, password, onClose }) {
  const t = useT();
  const copy = () => navigator.clipboard?.writeText(`${t('Username')}: ${username}\n${t('Temporary password')}: ${password}`)
    .then(() => useStore.getState().showToast(t('Copied')), () => {});
  return (
    <div className="temp-pass">
      <p>{t('Share these credentials with the employee through a secure channel. The password is shown only once and must be changed at first sign-in.')}</p>
      <div className="cred"><span className="muted">{t('Username')}</span><code>{username}</code></div>
      <div className="cred"><span className="muted">{t('Temporary password')}</span><code>{password}</code></div>
      <div className="row gap">
        <button className="btn primary" onClick={copy}><Icon name="copy" size={18} /> {t('Copy')}</button>
        <button className="btn ghost" onClick={onClose}>{t('Done')}</button>
      </div>
    </div>
  );
}

function UserForm({ user, onSaved, onCancel }) {
  const t = useT();
  const [f, setF] = useState(user ? {
    displayName: user.displayName, title: user.title, role: user.role, canCreateGroups: user.canCreateGroups, canStartDirect: user.canStartDirect,
  } : { username: '', displayName: '', title: '', role: 'employee', canCreateGroups: false, canStartDirect: true });
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = user ? await api.patch(`/admin/users/${user.id}`, f) : await api.post('/admin/users', f);
      onSaved(r);
    } catch (err) { toastErr(err); } finally { setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={save}>
      {!user && (
        <label className="field"><span>{t('Username (used to sign in)')}</span>
          <input required autoFocus pattern="[a-zA-Z0-9._\-]{3,32}" title="3–32: a-z 0-9 . _ -" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.trim() })} />
        </label>
      )}
      <label className="field"><span>{t('Full name')}</span><input required maxLength={64} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></label>
      <label className="field"><span>{t('Position / department')}</span><input maxLength={64} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field"><span>{t('Role')}</span>
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="employee">{t('Employee')}</option>
          <option value="admin">{t('Administrator')}</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={f.canStartDirect} onChange={(e) => setF({ ...f, canStartDirect: e.target.checked })} /> {t('Can start private chats')}</label>
      <label className="check"><input type="checkbox" checked={f.canCreateGroups} onChange={(e) => setF({ ...f, canCreateGroups: e.target.checked })} /> {t('Can create groups')}</label>
      <div className="row gap">
        <button className="btn primary" disabled={busy}>{user ? t('Save') : t('Create account')}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </form>
  );
}

function Users() {
  const t = useT();
  const me = useStore((s) => s.me);
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('current');
  const [view, setView] = useState(null); // { kind: 'create' | 'edit' | 'cred', ... }
  const load = useCallback(() => api.get('/admin/users').then((r) => setUsers(r.users)).catch(toastErr), []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, msg) => {
    try { const r = await fn(); if (msg) useStore.getState().showToast(msg); load(); return r; } catch (err) { toastErr(err); return null; }
  };
  const confirm = (title, text, onConfirm, confirmLabel) => useStore.getState().openModal({
    type: 'confirm', title, text, danger: true, confirm: confirmLabel,
    onConfirm: async () => { await onConfirm(); useStore.getState().openModal({ type: 'admin' }); },
  });

  if (view?.kind === 'create' || view?.kind === 'edit') {
    return (
      <UserForm user={view.user} onCancel={() => setView(null)} onSaved={(r) => {
        load();
        setView(r.tempPassword ? { kind: 'cred', username: r.user.username, password: r.tempPassword } : null);
      }} />
    );
  }
  if (view?.kind === 'cred') return <TempPassword username={view.username} password={view.password} onClose={() => setView(null)} />;

  const shown = users
    .filter((u) => (filter === 'current' ? u.status !== 'removed' : u.status === 'removed'))
    .filter((u) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="stack">
      <div className="row gap wrap">
        <div className="search-box boxed grow"><Icon name="search" size={18} /><input placeholder={t('Search employees')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="segmented">
          <button className={filter === 'current' ? 'on' : ''} onClick={() => setFilter('current')}>{t('Current')}</button>
          <button className={filter === 'removed' ? 'on' : ''} onClick={() => setFilter('removed')}>{t('Removed')}</button>
        </div>
        <button className="btn primary" onClick={() => setView({ kind: 'create' })}><Icon name="plus" size={18} /> {t('Add employee')}</button>
      </div>
      <div className="admin-list">
        {shown.map((u) => (
          <div key={u.id} className={`admin-row ${u.status}`}>
            <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={40} />
            <div className="grow left min0">
              <div className="ellipsis">
                <b>{u.displayName}</b> <span className="muted">@{u.username}</span>
                {u.role === 'admin' && <span className="role-tag">{t('admin')}</span>}
                {u.status !== 'active' && <span className={`status-tag ${u.status}`}>{t(u.status)}</span>}
                {u.mustChangePassword && u.status === 'active' && <span className="status-tag pending">{t('temp password')}</span>}
              </div>
              <div className="muted small ellipsis">
                {u.title || '—'} · {t(u.canStartDirect ? 'private chats' : 'no private chats')} · {t(u.canCreateGroups ? 'can create groups' : 'no groups')}
              </div>
            </div>
            {u.status !== 'removed' && (
              <div className="admin-actions">
                <button className="btn ghost small" onClick={() => setView({ kind: 'edit', user: u })}>{t('Edit')}</button>
                {u.id !== me.id && (
                  <>
                    <button className="btn ghost small" onClick={async () => {
                      const r = await act(() => api.post(`/admin/users/${u.id}/reset-password`));
                      if (r) setView({ kind: 'cred', username: u.username, password: r.tempPassword });
                    }}>{t('Reset password')}</button>
                    {u.status === 'active'
                      ? <button className="btn ghost small" onClick={() => confirm(t('Deactivate account'), t("{name} will be signed out everywhere immediately and won't be able to sign in until reactivated.", { name: u.displayName }), () => act(() => api.post(`/admin/users/${u.id}/deactivate`), tr('Account deactivated')), t('Deactivate'))}>{t('Deactivate')}</button>
                      : <button className="btn ghost small" onClick={() => act(() => api.post(`/admin/users/${u.id}/reactivate`), t('Account reactivated'))}>{t('Reactivate')}</button>}
                    <button className="btn ghost small danger" onClick={() => confirm(t('Remove employee'), t('Remove {name}? Access is revoked immediately and they leave all groups. Their past messages stay available according to the retention policy. This cannot be undone.', { name: u.displayName }), () => act(() => api.del(`/admin/users/${u.id}`), tr('Employee removed')), t('Remove'))}>{t('Remove')}</button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {!shown.length && <div className="muted pad center">{t('No employees')}</div>}
      </div>
    </div>
  );
}

function GroupEditor({ groupId, onBack }) {
  const t = useT();
  const [g, setG] = useState(null);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState([]);
  const load = useCallback(() => api.get(`/admin/groups/${groupId}`).then((r) => setG(r.group)).catch(toastErr), [groupId]);
  useEffect(() => { load(); }, [load]);
  if (!g) return <div className="center pad"><span className="spinner" /></div>;

  const patch = (body) => api.patch(`/chats/${groupId}`, body).then(load).catch(toastErr);
  if (adding) {
    return (
      <div className="stack">
        <UserPicker selected={selected} onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} exclude={g.members.map((m) => m.id)} />
        <div className="row gap">
          <button className="btn primary" disabled={!selected.length} onClick={() => api.post(`/chats/${groupId}/members`, { userIds: selected }).then(() => { setAdding(false); setSelected([]); load(); }).catch(toastErr)}>{t('Add')} {selected.length || ''}</button>
          <button className="btn ghost" onClick={() => setAdding(false)}>{t('Cancel')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <button className="btn ghost self-start" onClick={onBack}><Icon name="back" size={18} /> {t('All groups')}</button>
      <label className="field"><span>{t('Group name')}</span>
        <input defaultValue={g.title} maxLength={128} onBlur={(e) => e.target.value.trim() && e.target.value !== g.title && patch({ title: e.target.value.trim() })} />
      </label>
      <label className="check"><input type="checkbox" checked={g.onlyAdminsPost} onChange={(e) => patch({ onlyAdminsPost: e.target.checked })} /> {t('Only group admins can post (announcement channel)')}</label>
      <label className="check"><input type="checkbox" checked={g.membersCanAdd} onChange={(e) => patch({ membersCanAdd: e.target.checked })} /> {t('Members can add people')}</label>
      <div className="row"><b className="grow">{t('members', { n: g.members.length })}</b><button className="btn ghost small" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> {t('Add members')}</button></div>
      <div className="admin-list">
        {g.members.map((m) => (
          <div key={m.id} className="admin-row">
            <Avatar name={m.displayName} color={m.avatarColor} src={m.avatarUrl} size={36} />
            <div className="grow left">{m.displayName} <span className="muted">@{m.username}</span> {m.memberRole !== 'member' && <span className="role-tag">{t(m.memberRole)}</span>}</div>
            <div className="admin-actions">
              {m.memberRole !== 'owner' && (
                <button className="btn ghost small" onClick={() => api.patch(`/chats/${groupId}/members/${m.id}`, { role: m.memberRole === 'admin' ? 'member' : 'admin' }).then(load).catch(toastErr)}>
                  {t(m.memberRole === 'admin' ? 'Revoke admin' : 'Make admin')}
                </button>
              )}
              <button className="btn ghost small danger" onClick={() => api.del(`/chats/${groupId}/members/${m.id}`).then(load).catch(toastErr)}>{t('Remove')}</button>
            </div>
          </div>
        ))}
      </div>
      <button className="btn ghost danger self-start" onClick={() => useStore.getState().openModal({
        type: 'confirm', title: t('Archive group'), danger: true, confirm: t('Archive'),
        text: t('Archive “{title}”? Members lose access; the history is kept for retention.', { title: g.title }),
        onConfirm: async () => { await api.del(`/admin/groups/${groupId}`); useStore.getState().openModal({ type: 'admin', tab: 'groups' }); },
      })}><Icon name="archive" size={18} /> {t('Archive group')}</button>
    </div>
  );
}

function Groups() {
  const t = useT();
  const [groups, setGroups] = useState([]);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState([]);
  const load = useCallback(() => api.get('/admin/groups').then((r) => setGroups(r.groups)).catch(toastErr), []);
  useEffect(() => { load(); }, [load]);

  if (open) return <GroupEditor groupId={open} onBack={() => { setOpen(null); load(); }} />;
  if (creating) {
    return (
      <div className="stack">
        <label className="field"><span>{t('Group name')}</span><input autoFocus value={title} maxLength={128} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="muted small">{t('Select members ({n}). The first selected member becomes the owner.', { n: members.length })}</div>
        <UserPicker selected={members} onToggle={(id) => setMembers((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} />
        <div className="row gap">
          <button className="btn primary" disabled={!title.trim()} onClick={() => api.post('/admin/groups', { title, memberIds: members, ownerId: members[0] })
            .then(() => { setCreating(false); setTitle(''); setMembers([]); load(); }).catch(toastErr)}>{t('Create group')}</button>
          <button className="btn ghost" onClick={() => setCreating(false)}>{t('Cancel')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="row"><span className="grow muted">{t('groups', { n: groups.length })}</span><button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={18} /> {t('New group')}</button></div>
      <div className="admin-list">
        {groups.map((g) => (
          <button key={g.id} className="admin-row clickable" onClick={() => setOpen(g.id)}>
            <Avatar name={g.title} color={g.id % 8} size={40} group />
            <div className="grow left">
              <b>{g.title}</b>
              <div className="muted small">
                {t('members', { n: g.memberCount })}{g.onlyAdminsPost ? ` · ${t('announcements')}` : ''}
                {g.lastActivity ? ` · ${t('active {date}', { date: new Date(g.lastActivity).toLocaleDateString(locale()) })}` : ''}
              </div>
            </div>
            <Icon name="back" className="rot-180 muted-icon" />
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingsTab() {
  const t = useT();
  const [days, setDays] = useState(null);
  useEffect(() => { api.get('/admin/settings').then((r) => setDays(r.retentionDays)).catch(toastErr); }, []);
  if (days === null) return <div className="center pad"><span className="spinner" /></div>;
  return (
    <div className="stack">
      <h3>{t('Message retention')}</h3>
      <p className="muted">{t('Messages (including ones users deleted) and their files are kept for this many days, then permanently purged. Set 0 to keep history forever.')}</p>
      <div className="row gap">
        <input type="number" min={0} max={36500} value={days} onChange={(e) => setDays(Number(e.target.value))} className="narrow" />
        <span>{t('days')}</span>
        <button className="btn primary" onClick={() => api.put('/admin/settings', { retentionDays: days }).then(() => useStore.getState().showToast(t('Retention policy saved'))).catch(toastErr)}>{t('Save')}</button>
      </div>
      <p className="muted small">{t('The policy runs automatically every 6 hours.')}</p>
    </div>
  );
}

function Audit() {
  const t = useT();
  const [entries, setEntries] = useState([]);
  useEffect(() => { api.get('/admin/audit').then((r) => setEntries(r.entries)).catch(toastErr); }, []);
  return (
    <div className="admin-list audit">
      {entries.map((e) => (
        <div key={e.id} className="admin-row">
          <div className="grow left min0">
            <div><b>{e.action.replace(/_/g, ' ')}</b> {e.targetType && <span className="muted">· {e.targetType} #{e.targetId}</span>}</div>
            <div className="muted small ellipsis">{e.actorName || t('system')} · {new Date(e.createdAt).toLocaleString(locale())} {e.ip ? `· ${e.ip}` : ''} {e.details ? `· ${JSON.stringify(e.details)}` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminPanel({ modal, close }) {
  const t = useT();
  const [tab, setTab] = useState(modal.tab || 'users');
  return (
    <Modal title={t('Admin panel')} onClose={close} wide>
      <div className="tabs">
        {[['users', 'Employees'], ['groups', 'Groups'], ['settings', 'Retention'], ['audit', 'Audit log']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(label)}</button>
        ))}
      </div>
      <div className="admin-body">
        {tab === 'users' && <Users />}
        {tab === 'groups' && <Groups />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'audit' && <Audit />}
      </div>
    </Modal>
  );
}
