import { Router } from 'express';
import Busboy from 'busboy';
import rateLimit from 'express-rate-limit';
import { PassThrough } from 'node:stream';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncH, HttpError } from '../middleware.js';
import { requireMember, assertCanPost } from '../services/chats.js';
import { contentDisposition, newStorageKey, storage } from '../services/storage.js';

const router = Router();

// Types the browser may render inline. Everything else (including SVG and HTML) is forced to download.
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/x-m4a',
  'application/pdf',
]);

const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();

function kindFor(mime, requested) {
  const m = baseMime(mime);
  if (requested === 'voice' && (m.startsWith('audio/') || m === 'video/webm')) return 'voice';
  if (m.startsWith('image/') && INLINE_TYPES.has(m)) return 'image';
  if (m.startsWith('video/') && INLINE_TYPES.has(m)) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

const uploadLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 120,
  keyGenerator: (req) => `u${req.user.id}`,
  message: { error: 'Too many uploads. Please wait a few minutes.', code: 'RATE_LIMITED' },
  validate: { keyGeneratorIpFallback: false },
});

/**
 * Streams a multipart upload straight to storage. Metadata fields (kind, duration, width, height,
 * waveform) must be sent before the file part.
 */
router.post('/chats/:chatId/files', uploadLimiter, asyncH(async (req, res) => {
  const chatId = Number(req.params.chatId);
  if (!Number.isInteger(chatId)) throw new HttpError(404, 'Chat not found.', 'NOT_FOUND');
  const chat = await requireMember(chatId, req.user.id);
  assertCanPost(chat);
  const maxBytes = config.storage.maxUploadMb * 1024 * 1024;

  const result = await new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 10, fieldSize: 16 * 1024 } });
    } catch {
      reject(new HttpError(400, 'Expected multipart/form-data.', 'VALIDATION'));
      return;
    }
    const fields = {};
    let handled = false;
    let sink = null;
    // Stops a broken upload: without this a dropped connection leaves the request waiting forever.
    const fail = (err) => {
      req.unpipe(bb);
      sink?.destroy(err);
      reject(err);
    };
    req.on('close', () => {
      if (!req.complete) fail(new HttpError(400, 'The upload was interrupted.', 'UPLOAD_ABORTED'));
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (_name, stream, info) => {
      handled = true;
      const mime = baseMime(info.mimeType) || 'application/octet-stream';
      const fileName = (info.filename || 'file').replace(/[\x00-\x1f\\/]/g, '_').slice(0, 200) || 'file';
      const key = newStorageKey(chatId);
      let size = 0;
      let truncated = false;
      const counter = new PassThrough();
      sink = counter;
      counter.on('error', () => {}); // reported through storage.put
      stream.on('error', fail);
      stream.on('data', (chunk) => { size += chunk.length; });
      stream.on('limit', () => { truncated = true; });
      stream.pipe(counter);
      storage.put(key, counter, mime).then(async () => {
        if (truncated || size === 0) {
          await storage.remove(key).catch(() => {});
          return reject(truncated
            ? new HttpError(413, `File is larger than ${config.storage.maxUploadMb} MB.`, 'TOO_LARGE')
            : new HttpError(400, 'File is empty.', 'VALIDATION'));
        }
        resolve({ key, mime, fileName, size, fields });
      }, async (err) => {
        await storage.remove(key).catch(() => {}); // don't keep a partial file
        reject(err);
      });
    });
    bb.on('close', () => { if (!handled) reject(new HttpError(400, 'No file uploaded.', 'VALIDATION')); });
    bb.on('error', fail);
    req.pipe(bb);
  });

  const f = result.fields;
  const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let waveform = null;
  try {
    const w = JSON.parse(f.waveform || 'null');
    if (Array.isArray(w)) waveform = w.slice(0, 128).map((x) => Math.max(0, Math.min(1, Number(x) || 0)));
  } catch { /* ignore malformed waveform */ }

  const { rows } = await query(
    `INSERT INTO files (uploader_id, chat_id, storage_key, file_name, mime_type, size_bytes, kind, width, height, duration_sec, waveform)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [req.user.id, chatId, result.key, result.fileName, result.mime, result.size, kindFor(result.mime, f.kind),
      num(f.width), num(f.height), num(f.duration), waveform ? JSON.stringify(waveform) : null],
  );
  const r = rows[0];
  res.status(201).json({
    file: {
      id: r.id, name: r.file_name, mime: r.mime_type, size: r.size_bytes, kind: r.kind,
      width: r.width, height: r.height, duration: r.duration_sec, waveform: r.waveform, url: `/api/files/${r.id}`,
    },
  });
}));

/** Permission-checked download: uploader, or a member of any chat where a visible message references the file. */
router.get('/files/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'File not found.', 'NOT_FOUND');
  const { rows } = await query(
    `SELECT f.* FROM files f
      WHERE f.id = $1 AND (
        f.uploader_id = $2 OR EXISTS (
          SELECT 1 FROM messages m
            JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
            JOIN chats c ON c.id = m.chat_id AND c.archived_at IS NULL
           WHERE m.file_id = f.id AND m.deleted_at IS NULL AND m.id > cm.cleared_before_id))`,
    [id, req.user.id],
  );
  const file = rows[0];
  if (!file) throw new HttpError(404, 'File not found.', 'NOT_FOUND');
  const inline = INLINE_TYPES.has(file.mime_type) && req.query.download !== '1';
  await storage.serve(req, res, file.storage_key, {
    mime: inline ? file.mime_type : 'application/octet-stream',
    disposition: contentDisposition(inline ? 'inline' : 'attachment', file.file_name),
  });
}));

export default router;
