import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { S3Client, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config.js';
import { HttpError } from '../middleware.js';

const cfg = config.storage;

// A file id always refers to the same bytes, so devices may keep a copy for a week.
const FILE_CACHE = 'private, max-age=604800';

export function newStorageKey(chatId) {
  const d = new Date();
  return `chats/${chatId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomBytes(18).toString('base64url')}`;
}

/** Content-Disposition with an RFC 5987 encoded file name. */
export function contentDisposition(type, fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

class LocalStorage {
  constructor(dir) { this.dir = path.resolve(dir); }
  pathFor(key) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(this.dir + path.sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key, stream) {
    const p = this.pathFor(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await pipeline(stream, fs.createWriteStream(p));
  }
  async remove(key) { await fsp.rm(this.pathFor(key), { force: true }); }
  /** Local driver streams through Express (supports Range requests). */
  async serve(req, res, key, { mime, disposition }) {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', FILE_CACHE);
    res.sendFile(this.pathFor(key), { headers: { 'Content-Type': mime } });
  }
  async check() { await fsp.mkdir(this.dir, { recursive: true }); }
}

class S3Storage {
  constructor() {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async put(key, stream, mime) {
    await new Upload({
      client: this.client,
      params: { Bucket: cfg.bucket, Key: key, Body: stream, ContentType: mime },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
    }).done();
  }
  async remove(key) { await this.client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })); }
  /**
   * The bucket stays private and files are streamed through the app after the permission check.
   * (Redirecting to short-lived signed links broke images on iPhone once a link expired.)
   * Range requests are passed through so videos and voice messages can seek.
   */
  async serve(req, res, key, { mime, disposition }) {
    let object;
    try {
      object = await this.client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: req.headers.range }));
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      if (status === 404 || err.name === 'NoSuchKey') throw new HttpError(404, 'File not found.', 'NOT_FOUND');
      if (status === 416) {
        res.status(416).end();
        return;
      }
      throw err;
    }
    res.status(object.ContentRange ? 206 : 200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', FILE_CACHE);
    res.setHeader('Accept-Ranges', 'bytes');
    if (object.ContentLength !== undefined) res.setHeader('Content-Length', object.ContentLength);
    if (object.ContentRange) res.setHeader('Content-Range', object.ContentRange);
    if (object.ETag) res.setHeader('ETag', object.ETag);
    await pipeline(object.Body, res).catch(() => {}); // the viewer closed the photo mid-download
  }
  async check() { await this.client.send(new HeadBucketCommand({ Bucket: cfg.bucket })); }
}

export const storage = cfg.driver === 's3' ? new S3Storage() : new LocalStorage(cfg.localDir);
