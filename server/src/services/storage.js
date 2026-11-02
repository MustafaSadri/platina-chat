import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { S3Client, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const cfg = config.storage;

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
  async serve(res, key, { mime, disposition }) {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'private, max-age=3600');
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
  /** The bucket stays private; after the permission check we hand out a 60-second signed URL. */
  async serve(res, key, { mime, disposition }) {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key, ResponseContentType: mime, ResponseContentDisposition: disposition }),
      { expiresIn: 60 },
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(302, url);
  }
  async check() { await this.client.send(new HeadBucketCommand({ Bucket: cfg.bucket })); }
}

export const storage = cfg.driver === 's3' ? new S3Storage() : new LocalStorage(cfg.localDir);
