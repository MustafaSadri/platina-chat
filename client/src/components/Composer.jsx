import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { duration, messagePreview } from '../lib/format.js';
import { resetTyping, sendTyping } from '../lib/socket.js';
import { detectLangClient, useT } from '../lib/i18n.js';
import Icon from './Icons.jsx';

const EMOJI = ['😀', '😂', '😊', '😍', '🤔', '😎', '😢', '😡', '👍', '👎', '👏', '🙏', '💪', '🤝', '👌', '✌️',
  '❤️', '🔥', '🎉', '✅', '❌', '⚠️', '📌', '📎', '📅', '⏰', '💼', '📈', '📉', '💡', '🚀', '☕'];

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

function imageSize(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve({});
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({}); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/** Voice recorder: MediaRecorder + an analyser that samples amplitude for the waveform. */
function useRecorder() {
  const [state, setState] = useState(null); // { started, elapsed, levels }
  const ref = useRef({});

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Voice messages need HTTPS and a browser that supports recording.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const levels = [];
    const started = Date.now();
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      levels.push(Math.min(1, peak / 64));
      setState({ started, elapsed: (Date.now() - started) / 1000, levels: levels.slice(-48) });
    }, 100);
    rec.start(250);
    ref.current = { rec, stream, ctx, timer, chunks, levels, started, mime: rec.mimeType || mime };
    setState({ started, elapsed: 0, levels: [] });
  }

  function stop(keep) {
    const { rec, stream, ctx, timer, chunks, levels, started, mime } = ref.current;
    if (!rec) return Promise.resolve(null);
    clearInterval(timer);
    ref.current = {};
    setState(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        if (!keep) return resolve(null);
        const type = (mime || 'audio/webm').split(';')[0];
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(chunks, { type });
        // Downsample the amplitude history to 48 bars.
        const bars = 48;
        const wave = Array.from({ length: bars }, (_, i) => {
          const slice = levels.slice(Math.floor((i * levels.length) / bars), Math.floor(((i + 1) * levels.length) / bars));
          return slice.length ? Math.round((Math.max(...slice) || 0) * 100) / 100 : 0;
        });
        resolve({ file: new File([blob], `voice-${Date.now()}.${ext}`, { type }), duration: (Date.now() - started) / 1000, waveform: wave });
      };
      rec.stop();
    });
  }

  useEffect(() => () => { if (ref.current.rec) stop(false); }, []);
  return { state, start, stop };
}

export default function Composer({ chat }) {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const t = useT();
  const translationEnabled = useStore((s) => s.config.translation);
  const [draftOriginal, setDraftOriginal] = useState(null); // { text, target } after translating a draft
  const [translatingDraft, setTranslatingDraft] = useState(false);
  const replyTo = useStore((s) => s.replyTo);
  const editing = useStore((s) => s.editing);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const input = useRef();
  const fileInput = useRef();
  const recorder = useRecorder();
  const draftKey = `draft-${chat.id}`;

  const canModerate = chat.type === 'group' && ['owner', 'admin'].includes(chat.myRole);
  const readOnly = chat.type === 'group' && chat.onlyAdminsPost && !canModerate;
  const peerInactive = chat.type === 'direct' && chat.peer && users[chat.peer.id]?.status && users[chat.peer.id].status !== 'active';

  // Drafts per chat survive navigation and reloads.
  useEffect(() => {
    try { setText(sessionStorage.getItem(draftKey) || ''); } catch { /* ignore */ }
  }, [draftKey]);
  useEffect(() => {
    try { if (text) sessionStorage.setItem(draftKey, text); else sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
  }, [text, draftKey]);

  useEffect(() => {
    if (editing) { setText(editing.body); input.current?.focus(); }
  }, [editing]);
  useEffect(() => { if (replyTo) input.current?.focus(); }, [replyTo]);

  // Auto-grow textarea.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    const onFiles = (e) => sendFiles(e.detail);
    window.addEventListener('composer-files', onFiles);
    return () => window.removeEventListener('composer-files', onFiles);
  });

  async function sendFiles(files) {
    const maxMb = useStore.getState().config.maxUploadMb;
    const s = useStore.getState();
    const caption = files.length === 1 ? text.trim() : '';
    if (caption) setText('');
    for (const f of files) {
      if (f.size > maxMb * 1024 * 1024) { s.showToast(t('“{name}” is larger than {mb} MB.', { name: f.name, mb: maxMb }), 'error'); continue; }
      const dims = await imageSize(f);
      s.sendFile(chat.id, f, { caption, replyTo: s.replyTo, fields: dims });
    }
    useStore.setState({ replyTo: null });
  }

  async function submit() {
    const body = text.trim();
    const s = useStore.getState();
    if (editing) {
      if (body !== editing.body && (body || editing.file)) {
        try {
          const { message } = await api.patch(`/messages/${editing.id}`, { body });
          s.updateMessage(message);
        } catch (err) { s.showToast(err, 'error'); return; }
      }
      useStore.setState({ editing: null });
      setText('');
      return;
    }
    if (!body) return;
    setText('');
    setDraftOriginal(null);
    setEmojiOpen(false);
    // Split very long texts like Telegram does (server limit 10k chars).
    const chunks = body.match(/[\s\S]{1,10000}/g);
    for (const [i, chunk] of chunks.entries()) s.send(chat.id, { body: chunk, replyTo: i === 0 ? replyTo : null });
    resetTyping(chat.id);
    useStore.setState({ replyTo: null });
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch() && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && !text) {
      const mine = [...(useStore.getState().messages[chat.id] || [])].reverse().find((m) => m.senderId === me.id && m.type === 'text' && !m.pending);
      if (mine) { e.preventDefault(); useStore.setState({ editing: mine }); }
    } else if (e.key === 'Escape' && (editing || replyTo)) {
      useStore.setState({ editing: null, replyTo: null });
      if (editing) setText('');
    }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); sendFiles(files); }
  }

  /** Translates the draft into the other language (EN<->RU) before sending; can be undone. */
  async function translateDraft() {
    const body = text.trim();
    if (!body || translatingDraft) return;
    const target = detectLangClient(body) === 'ru' ? 'en' : 'ru';
    setTranslatingDraft(true);
    try {
      const { translation } = await api.post('/translate', { text: body, target });
      setDraftOriginal({ text, target });
      setText(translation.text);
      input.current?.focus();
    } catch (err) {
      useStore.getState().showToast(err, 'error');
    } finally {
      setTranslatingDraft(false);
    }
  }

  async function startRecording() {
    try {
      await recorder.start();
      sendTyping(chat.id, 'voice');
    } catch (err) {
      useStore.getState().showToast(err.name === 'NotAllowedError' ? t('Microphone permission denied.') : err.message, 'error');
    }
  }

  async function finishRecording(send) {
    const result = await recorder.stop(send);
    if (!result || result.duration < 0.7) return;
    const s = useStore.getState();
    s.sendFile(chat.id, result.file, {
      kind: 'voice', replyTo: s.replyTo,
      fields: { duration: result.duration.toFixed(2), waveform: JSON.stringify(result.waveform) },
    });
    useStore.setState({ replyTo: null });
  }

  useEffect(() => {
    if (recorder.state) {
      const timer = setInterval(() => sendTyping(chat.id, 'voice'), 3000);
      return () => clearInterval(timer);
    }
  }, [!!recorder.state, chat.id]);

  if (readOnly) return <div className="composer readonly muted">{t('Only admins can post in this group.')}</div>;
  if (peerInactive) return <div className="composer readonly muted">{t('This account is no longer active.')}</div>;

  const bar = editing || replyTo;
  const draftTarget = text.trim() ? (detectLangClient(text) === 'ru' ? 'en' : 'ru') : null;
  return (
    <div className="composer-wrap">
      {bar && (
        <div className="composer-bar">
          <Icon name={editing ? 'edit' : 'reply'} className="accent" />
          <div className="composer-bar-text">
            <div className="accent small strong">{editing ? t('Edit message') : t('Reply to {name}', { name: users[replyTo.senderId]?.displayName || '' })}</div>
            <div className="ellipsis small">{messagePreview(bar, users)}</div>
          </div>
          <button className="icon-btn" onClick={() => { useStore.setState({ editing: null, replyTo: null }); if (editing) setText(''); }} aria-label={t('Cancel')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {draftOriginal && !bar && (
        <div className="composer-bar">
          <Icon name="translate" className="accent" />
          <div className="composer-bar-text">
            <div className="accent small strong">{t(draftOriginal.target === 'en' ? 'Translated to English' : 'Translated to Russian')}</div>
            <div className="ellipsis small">{draftOriginal.text}</div>
          </div>
          <button className="btn ghost small" onClick={() => { setText(draftOriginal.text); setDraftOriginal(null); }}>{t('Show original')}</button>
        </div>
      )}
      {emojiOpen && (
        <div className="emoji-panel">
          {EMOJI.map((e) => <button key={e} onClick={() => { setText((x) => x + e); input.current?.focus(); }}>{e}</button>)}
        </div>
      )}
      {recorder.state ? (
        <div className="composer recording">
          <button className="icon-btn danger" onClick={() => finishRecording(false)} aria-label={t('Cancel')}><Icon name="trash" /></button>
          <span className="rec-dot" />
          <span className="rec-time">{duration(recorder.state.elapsed)}</span>
          <div className="rec-levels">{recorder.state.levels.map((l, i) => <span key={i} style={{ height: `${Math.max(10, l * 100)}%` }} />)}</div>
          <button className="send-btn" onClick={() => finishRecording(true)} aria-label={t('Send')}><Icon name="send" /></button>
        </div>
      ) : (
        <div className="composer">
          <button className="icon-btn" onClick={() => setEmojiOpen(!emojiOpen)} aria-label={t('Emoji')}><Icon name="smile" /></button>
          <textarea
            ref={input}
            rows={1}
            placeholder={editing ? t('Edit message') : t('Message')}
            value={text}
            onChange={(e) => { setText(e.target.value); if (!e.target.value) setDraftOriginal(null); if (e.target.value) sendTyping(chat.id); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            enterKeyHint={isTouch() ? 'enter' : 'send'}
          />
          {translationEnabled && draftTarget && !draftOriginal && (
            <button className="icon-btn" onClick={translateDraft} disabled={translatingDraft}
              aria-label={t(draftTarget === 'en' ? 'Translate to English' : 'Translate to Russian')} title={t(draftTarget === 'en' ? 'Translate to English' : 'Translate to Russian')}>
              {translatingDraft ? <span className="spinner small" /> : <Icon name="translate" />}
            </button>
          )}
          {!editing && (
            <button className="icon-btn" onClick={() => fileInput.current.click()} aria-label={t('Attach file')}><Icon name="attach" /></button>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { sendFiles([...e.target.files]); e.target.value = ''; }} />
          {text.trim() || editing ? (
            <button className="send-btn" onClick={submit} aria-label={t('Send')}><Icon name={editing ? 'check' : 'send'} /></button>
          ) : (
            <button className="send-btn mic" onClick={startRecording} aria-label={t('Record voice message')}><Icon name="mic" /></button>
          )}
        </div>
      )}
    </div>
  );
}
