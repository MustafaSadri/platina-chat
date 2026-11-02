import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError } from '../middleware.js';

// English <-> Russian translation through a configurable provider. Message text is sent to that
// provider, so the feature stays disabled until an administrator configures one.
export const LANGS = ['en', 'ru'];

/** EN/RU detection by script: Cyrillic letters mean Russian. Reliable for this language pair. */
export function detectLang(text) {
  const cyr = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  return cyr > lat ? 'ru' : 'en';
}

const t = config.translate;

const providers = {
  async deepl(text, target) {
    const host = t.deeplKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const res = await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${t.deeplKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], target_lang: target === 'en' ? 'EN-US' : 'RU' }),
    });
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
    const data = await res.json();
    return { text: data.translations[0].text, source: data.translations[0].detected_source_language?.toLowerCase() };
  },
  async google(text, target) {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(t.googleKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target, format: 'text' }),
    });
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const data = await res.json();
    return { text: data.data.translations[0].translatedText, source: data.data.translations[0].detectedSourceLanguage };
  },
  async libretranslate(text, target) {
    const res = await fetch(`${t.libreUrl.replace(/\/$/, '')}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'auto', target, format: 'text', ...(t.libreKey && { api_key: t.libreKey }) }),
    });
    if (!res.ok) throw new Error(`LibreTranslate HTTP ${res.status}`);
    const data = await res.json();
    return { text: data.translatedText, source: data.detectedLanguage?.language };
  },
  // Deterministic provider for automated tests only (TRANSLATE_PROVIDER=test).
  async test(text, target) {
    return { text: `[${target}] ${text}`, source: detectLang(text) };
  },
};

export function translationEnabled() {
  switch (t.provider) {
    case 'deepl': return Boolean(t.deeplKey);
    case 'google': return Boolean(t.googleKey);
    case 'libretranslate': return Boolean(t.libreUrl);
    case 'test': return !config.isProd;
    default: return false;
  }
}

/** Resolves 'auto' to the other language of the pair. */
export function resolveTarget(text, target) {
  if (target === 'en' || target === 'ru') return target;
  return detectLang(text) === 'ru' ? 'en' : 'ru';
}

export async function translateText(text, target) {
  if (!translationEnabled()) throw new HttpError(503, 'Translation is not configured on this server.', 'TRANSLATION_DISABLED');
  const to = resolveTarget(text, target);
  const source = detectLang(text);
  if (source === to) return { text, source, target: to, unchanged: true };
  try {
    const r = await providers[t.provider](text, to);
    return { text: r.text, source: r.source || source, target: to };
  } catch (err) {
    console.error('[translate]', err.message);
    throw new HttpError(502, 'The translation service is unavailable. Try again later.', 'TRANSLATION_FAILED');
  }
}

/** Translates a stored message, caching per (message, target). Edits clear the cache. */
export async function translateMessage(messageId, body, target) {
  const to = resolveTarget(body, target);
  const cached = await query('SELECT * FROM message_translations WHERE message_id = $1 AND target_lang = $2', [messageId, to]);
  if (cached.rows[0]) return { text: cached.rows[0].text, source: cached.rows[0].source_lang, target: to, cached: true };
  const r = await translateText(body, to);
  if (!r.unchanged) {
    await query(
      `INSERT INTO message_translations (message_id, target_lang, source_lang, text, provider) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, target_lang) DO UPDATE SET text = EXCLUDED.text, source_lang = EXCLUDED.source_lang`,
      [messageId, to, r.source, r.text, t.provider],
    );
  }
  return r;
}
