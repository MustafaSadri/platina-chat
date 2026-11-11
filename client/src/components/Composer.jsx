import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { duration, messagePreview, prepareImage } from '../lib/format.js';
import { resetTyping, sendTyping } from '../lib/socket.js';
import { detectLangClient, useT } from '../lib/i18n.js';
import Icon from './Icons.jsx';
import Avatar from './Avatar.jsx';

/** Telegram-style preview of chosen photos and files, with a caption, before anything is sent. */
function MediaPreview({ files, initialCaption, onCancel, onSend }) {
  const t = useT();
  const [caption, setCaption] = useState(initialCaption);
  const previews = useMemo(() => files.map((f) => ({
    file: f,
    kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'file',
    url: f.type.startsWith('image/') || f.type.startsWith('video/') ? URL.createObjectURL(f) : null,
  })), [files]);
  useEffect(() => () => previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)), [previews]);
  const photos = previews.every((p) => p.kind === 'image');
  const title = files.length === 1
    ? t(photos ? 'Send photo' : 'Send file')
    : t(photos ? 'Send {n} photos' : 'Send {n} files', { n: files.length });
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal media-preview" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-header">
          <span className="strong">{title}</span>
          <button className="icon-btn" onClick={onCancel} aria-label={t('Cancel')}><Icon name="close" /></button>
        </div>
        <div className="modal-body">
          <div className={`preview-grid count-${Math.min(files.length, 4)}`}>
            {previews.map((p, i) => (
              <div key={i} className="preview-item">
                {p.kind === 'image' && <img src={p.url} alt={p.file.name} />}
                {p.kind === 'video' && <video src={p.url} muted playsInline preload="metadata" />}
                {p.kind === 'file' && <div className="preview-file"><Icon name="file" size={28} /><span className="ellipsis small">{p.file.name}</span></div>}
              </div>
            ))}
          </div>
          <textarea className="caption-input" rows={2} autoFocus={!isTouch()} placeholder={t('Add a caption…')} value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); onSend(caption.trim()); } }} />
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onCancel}>{t('Cancel')}</button>
          <button className="btn primary media-send" onClick={() => onSend(caption.trim())}><Icon name="send" size={18} /> {t('Send')}</button>
        </div>
      </div>
    </div>
  );
}

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
  const [staged, setStaged] = useState(null); // files waiting in the caption preview
  const [mention, setMention] = useState(null); // { query, start, end, index } while typing @name
  const [members, setMembers] = useState([]);
  // Where the cursor goes after the app changes the text, applied in the same paint so fast typing lands in the right place.
  const caretAfterUpdate = useRef(null);
  useLayoutEffect(() => {
    if (caretAfterUpdate.current === null || !input.current) return;
    input.current.setSelectionRange(caretAfterUpdate.current, caretAfterUpdate.current);
    caretAfterUpdate.current = null;
  }, [text]);

  useEffect(() => {
    if (chat.type !== 'group') return undefined;
    const load = () => api.get(`/chats/${chat.id}`).then((r) => setMembers(r.chat.members)).catch(() => {});
    load();
    const onChange = (e) => e.detail === chat.id && load();
    window.addEventListener('members-changed', onChange);
    return () => window.removeEventListener('members-changed', onChange);
  }, [chat.id, chat.type, chat.memberCount]);

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

  /** Chosen files wait in a preview where a caption can be added, like Telegram. */
  function sendFiles(files) {
    const maxMb = useStore.getState().config.maxUploadMb;
    const ok = files.filter((f) => {
      if (f.size <= maxMb * 1024 * 1024) return true;
      useStore.getState().showToast(t('“{name}” is larger than {mb} MB.', { name: f.name, mb: maxMb }), 'error');
      return false;
    });
    if (ok.length) setStaged(ok);
  }

  async function sendStaged(caption) {
    const files = staged;
    setStaged(null);
    const s = useStore.getState();
    const replyTo = s.replyTo;
    useStore.setState({ replyTo: null });
    setText('');
    for (const [i, original] of files.entries()) {
      const f = await prepareImage(original);
      const dims = await imageSize(f);
      s.sendFile(chat.id, f, { caption: i === 0 ? caption : '', replyTo: i === 0 ? replyTo : null, fields: dims });
    }
  }

  // ---- @mentions (groups only)
  function updateMention(value, caret) {
    if (chat.type !== 'group') return setMention(null);
    const match = /(?:^|\s)@([\w.-]{0,32})$/.exec(value.slice(0, caret));
    setMention(match ? { query: match[1].toLowerCase(), start: caret - match[1].length - 1, end: caret, index: 0 } : null);
  }
  const suggestions = mention
    ? members.filter((u) => u.id !== me.id && u.username
      && (u.username.toLowerCase().startsWith(mention.query) || u.displayName.toLowerCase().includes(mention.query))).slice(0, 6)
    : [];
  function pickMention(user) {
    const insert = `@${user.username} `;
    const next = text.slice(0, mention.start) + insert + text.slice(mention.end);
    const caret = mention.start + insert.length;
    caretAfterUpdate.current = caret;
    setText(next);
    setMention(null);
    input.current?.focus();
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
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMention((m) => ({ ...m, index: (m.index + step + suggestions.length) % suggestions.length }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(suggestions[mention.index] || suggestions[0]);
        return;
      }
      if (e.key === 'Escape') { setMention(null); return; }
    }
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
      {suggestions.length > 0 && (
        <div className="mention-list" role="listbox">
          {suggestions.map((u, i) => (
            <button key={u.id} role="option" aria-selected={i === mention.index} className={`mention-option ${i === mention.index ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(u)}>
              <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={32} />
              <span className="grow left ellipsis"><span className="strong">{u.displayName}</span> <span className="muted">@{u.username}</span></span>
            </button>
          ))}
        </div>
      )}
      {staged && <MediaPreview files={staged} initialCaption={text.trim()} onCancel={() => setStaged(null)} onSend={sendStaged} />}
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
            onChange={(e) => {
              setText(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
              if (!e.target.value) setDraftOriginal(null);
              if (e.target.value) sendTyping(chat.id);
            }}
            onSelect={(e) => updateMention(e.target.value, e.target.selectionStart)}
            onBlur={() => setTimeout(() => setMention(null), 150)}
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
