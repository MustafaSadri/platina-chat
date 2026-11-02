import { useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { errorText, useT } from '../lib/i18n.js';
import Icon from './Icons.jsx';

export function LanguageSwitch({ className = '' }) {
  const lang = useStore((s) => s.lang);
  return (
    <div className={`segmented ${className}`} role="group" aria-label="Language / Язык">
      <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => useStore.getState().setLang('en')}>English</button>
      <button type="button" className={lang === 'ru' ? 'on' : ''} onClick={() => useStore.getState().setLang('ru')}>Русский</button>
    </div>
  );
}

export function Login() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.post('/auth/login', { username, password });
      useStore.getState().setMe(user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <LanguageSwitch className="self-center" />
        <img src="/icon.svg" alt="" className="auth-logo" />
        <h1>TeamChat</h1>
        <p className="muted">{t('Sign in with the username and password provided by your administrator.')}</p>
        <label className="field">
          <span>{t('Username')}</span>
          <input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t('Password')}</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary block" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</button>
        <p className="muted small center"><Icon name="lock" size={14} />&nbsp;{t('Private workspace — accounts are created by the administrator.')}</p>
      </form>
    </div>
  );
}

export function ChangePassword({ forced = false, onDone }) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const me = useStore((s) => s.me);

  async function submit(e) {
    e.preventDefault();
    if (next !== confirm) return setError(t('The new passwords do not match.'));
    setBusy(true);
    setError('');
    try {
      const { user } = await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      useStore.getState().setMe(user);
      useStore.getState().showToast(t('Password changed. Other devices were signed out.'));
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    useStore.setState({ me: null });
  }

  const form = (
    <form className={forced ? 'auth-card' : 'stack'} onSubmit={submit}>
      {forced && (
        <>
          <LanguageSwitch className="self-center" />
          <img src="/icon.svg" alt="" className="auth-logo" />
          <h1>{t('Welcome, {name}', { name: me?.displayName })}</h1>
          <p className="muted">{t('Please replace your temporary password before continuing.')}</p>
        </>
      )}
      <label className="field">
        <span>{forced ? t('Temporary password') : t('Current password')}</span>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="field">
        <span>{t('New password')}</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
        <small className="muted">{t('At least 10 characters, with letters and numbers.')}</small>
      </label>
      <label className="field">
        <span>{t('Confirm new password')}</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      {error && <div className="form-error">{error}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? t('Saving…') : t('Change password')}</button>
      {forced && <button type="button" className="btn ghost block" onClick={logout}>{t('Sign out')}</button>}
    </form>
  );
  return forced ? <div className="auth-page">{form}</div> : form;
}
