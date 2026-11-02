// End-to-end tests against a real PostgreSQL (embedded-postgres) and a real HTTP + Socket.IO server.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { io as ioClient } from 'socket.io-client';

const PG_PORT = 54000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamchat-pg-'));
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamchat-up-'));
const pgServer = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'test', port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });

process.env.DATABASE_URL = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = uploadsDir;
process.env.MAX_UPLOAD_MB = '1';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.NODE_ENV = 'test';
process.env.TRANSLATE_PROVIDER = 'test';

let base;
let httpServer;
let ioServer;
let pool;
const sockets = [];

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), cookie: this.cookie, ...headers },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b || {}); }
  patch(u, b) { return this.req('PATCH', u, b); }
  del(u) { return this.req('DELETE', u); }
  socket() {
    return new Promise((resolve, reject) => {
      const s = ioClient(base, { extraHeaders: { cookie: this.cookie }, transports: ['websocket'], reconnection: false });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', (e) => reject(e));
    });
  }
}

const waitFor = (socket, event, pred = () => true, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout waiting for ${event}`)); }, ms);
  function h(data) { if (pred(data)) { clearTimeout(t); socket.off(event, h); resolve(data); } }
  socket.on(event, h);
});

async function login(username, password) {
  const c = new Client();
  const r = await c.post('/api/auth/login', { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

/** Creates an employee as admin and completes their first-login password change. */
async function makeEmployee(admin, username, extra = {}) {
  const r = await admin.post('/api/admin/users', { username, displayName: username.toUpperCase(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = await login(username, r.body.tempPassword);
  const ch = await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: `${username}-Secret123` });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  c.id = r.body.user.id;
  c.password = `${username}-Secret123`;
  return c;
}

let admin;
let alice;
let bob;
let carol;

before(async () => {
  await pgServer.initialise();
  await pgServer.start();
  const { start } = await import('../src/index.js');
  ({ pool } = await import('../src/db.js'));
  ({ server: httpServer, io: ioServer } = await start({ port: 0, handleSignals: false }));
  base = `http://127.0.0.1:${httpServer.address().port}`;

  // Bootstrap an admin directly, like scripts/create-admin.js does.
  const { hashPassword } = await import('../src/services/auth.js');
  await pool.query(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, can_create_groups)
     VALUES ('admin', 'Admin', 'admin', $1, FALSE, TRUE)`,
    [await hashPassword('AdminPass123')],
  );
  admin = await login('admin', 'AdminPass123');
});

after(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => setTimeout(r, 300)); // let disconnect handlers finish their DB writes
  ioServer?.close();
  httpServer?.close();
  await pool?.end();
  await pgServer.stop();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

describe('authentication & accounts', () => {
  test('there is no public registration endpoint', async () => {
    const c = new Client();
    const r = await c.post('/api/auth/register', { username: 'x', password: 'y' });
    assert.equal(r.status, 401);
    const r2 = await c.post('/api/admin/users', { username: 'hacker', displayName: 'H' });
    assert.equal(r2.status, 401);
  });

  test('wrong password is rejected with a generic message', async () => {
    const c = new Client();
    const r = await c.post('/api/auth/login', { username: 'admin', password: 'nope' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Invalid username or password.');
  });

  test('temporary password forces a password change before anything else', async () => {
    const r = await admin.post('/api/admin/users', { username: 'temp.user', displayName: 'Temp' });
    assert.equal(r.status, 201);
    assert.match(r.body.tempPassword, /^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/);
    const c = await login('temp.user', r.body.tempPassword);
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.user.mustChangePassword, true);
    assert.equal((await c.get('/api/chats')).status, 403);
    await assert.rejects(c.socket(), /PASSWORD_CHANGE_REQUIRED/);
    const weak = await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'short' });
    assert.equal(weak.status, 400);
    const ok = await c.post('/api/auth/change-password', { currentPassword: r.body.tempPassword, newPassword: 'BrandNew12345' });
    assert.equal(ok.status, 200);
    assert.equal((await c.get('/api/chats')).status, 200);
  });

  test('passwords are stored hashed', async () => {
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE username = 'admin'`);
    assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);
  });

  test('duplicate usernames are rejected (case-insensitive)', async () => {
    const r = await admin.post('/api/admin/users', { username: 'TEMP.user', displayName: 'Dup' });
    assert.equal(r.status, 409);
  });

  test('non-admins cannot use admin endpoints', async () => {
    alice = await makeEmployee(admin, 'alice', { canCreateGroups: true });
    bob = await makeEmployee(admin, 'bob');
    carol = await makeEmployee(admin, 'carol');
    assert.equal((await alice.get('/api/admin/users')).status, 403);
    assert.equal((await alice.post('/api/admin/users', { username: 'evil', displayName: 'E' })).status, 403);
  });

  test('cross-origin writes are blocked', async () => {
    const r = await alice.req('POST', '/api/chats/direct', { userId: bob.id }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });
});

describe('messaging', () => {
  let dm;
  let aliceSock;
  let bobSock;

  test('direct chat is created once per pair', async () => {
    const r1 = await alice.post('/api/chats/direct', { userId: bob.id });
    const r2 = await bob.post('/api/chats/direct', { userId: alice.id });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.chat.id, r2.body.chat.id);
    assert.equal(r1.body.chat.title, 'BOB');
    dm = r1.body.chat.id;
  });

  test('real-time delivery, delivered & read receipts', async () => {
    aliceSock = await alice.socket();
    bobSock = await bob.socket();
    const incoming = waitFor(bobSock, 'message:new', (m) => m.chatId === dm);
    const sent = await alice.post(`/api/chats/${dm}/messages`, { body: 'Hello Bob', clientId: 'cid-00000001' });
    assert.equal(sent.status, 201);
    const msg = await incoming;
    assert.equal(msg.body, 'Hello Bob');
    assert.equal(msg.senderId, alice.id);

    const delivered = waitFor(aliceSock, 'receipt', (r) => r.userId === bob.id && r.deliveredId >= msg.id);
    bobSock.emit('delivered', { chatId: dm, messageId: msg.id });
    await delivered;

    let list = (await alice.get('/api/chats')).body.chats.find((c) => c.id === dm);
    assert.ok(list.othersDeliveredId >= msg.id);
    assert.ok(list.othersReadId < msg.id);
    assert.equal((await bob.get('/api/chats')).body.chats.find((c) => c.id === dm).unread, 1);

    const read = waitFor(aliceSock, 'receipt', (r) => r.userId === bob.id && r.readId >= msg.id);
    await bob.post(`/api/chats/${dm}/read`, { messageId: msg.id });
    await read;
    list = (await alice.get('/api/chats')).body.chats.find((c) => c.id === dm);
    assert.ok(list.othersReadId >= msg.id);
    assert.equal((await bob.get('/api/chats')).body.chats.find((c) => c.id === dm).unread, 0);
  });

  test('explicit nulls for optional fields are accepted', async () => {
    const r = await alice.post(`/api/chats/${dm}/messages`, { body: 'with nulls', fileId: null, replyToId: null, type: null, clientId: 'cid-nulls-01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test('sending is idempotent on clientId (safe retries)', async () => {
    const a = await alice.post(`/api/chats/${dm}/messages`, { body: 'retry me', clientId: 'cid-retry-01' });
    const b = await alice.post(`/api/chats/${dm}/messages`, { body: 'retry me', clientId: 'cid-retry-01' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.message.id, b.body.message.id);
  });

  test('typing indicator reaches the other member', async () => {
    const typing = waitFor(bobSock, 'typing', (t) => t.chatId === dm && t.userId === alice.id);
    aliceSock.emit('typing', { chatId: dm });
    await typing;
  });

  test('reply, edit, react, pin, delete', async () => {
    const orig = (await bob.post(`/api/chats/${dm}/messages`, { body: 'Quarterly report attached soon' })).body.message;
    const reply = (await alice.post(`/api/chats/${dm}/messages`, { body: 'Thanks!', replyToId: orig.id })).body.message;
    assert.equal(reply.replyTo.id, orig.id);
    assert.match(reply.replyTo.body, /Quarterly/);

    assert.equal((await alice.patch(`/api/messages/${orig.id}`, { body: 'hijack' })).status, 403);
    const updated = waitFor(aliceSock, 'message:updated', (m) => m.id === orig.id);
    const edit = await bob.patch(`/api/messages/${orig.id}`, { body: 'Quarterly report attached now' });
    assert.equal(edit.status, 200);
    assert.ok(edit.body.message.editedAt);
    assert.equal((await updated).body, 'Quarterly report attached now');

    const reacted = waitFor(bobSock, 'message:reactions', (r) => r.messageId === orig.id);
    await alice.post(`/api/messages/${orig.id}/reactions`, { emoji: '👍' });
    assert.deepEqual((await reacted).reactions, [{ emoji: '👍', userIds: [alice.id] }]);
    const toggled = await alice.post(`/api/messages/${orig.id}/reactions`, { emoji: '👍' });
    assert.deepEqual(toggled.body.reactions, []);

    assert.equal((await alice.post(`/api/messages/${orig.id}/pin`)).status, 200);
    const pins = await bob.get(`/api/chats/${dm}/pins`);
    assert.equal(pins.body.messages[0].id, orig.id);

    assert.equal((await alice.del(`/api/messages/${orig.id}?forEveryone=1`)).status, 403);
    const deleted = waitFor(aliceSock, 'message:deleted', (d) => d.messageId === orig.id);
    assert.equal((await bob.del(`/api/messages/${orig.id}?forEveryone=1`)).status, 200);
    await deleted;
    const history = (await alice.get(`/api/chats/${dm}/messages`)).body.messages;
    assert.ok(!history.some((m) => m.id === orig.id));
    assert.equal(history.find((m) => m.id === reply.id).replyTo.deleted, true);
    // Retained server-side for the retention policy.
    const { rows } = await pool.query('SELECT body, deleted_at FROM messages WHERE id = $1', [orig.id]);
    assert.ok(rows[0].deleted_at);
    assert.equal((await bob.get(`/api/chats/${dm}/pins`)).body.messages.length, 0);
  });

  test('delete for me hides only for me', async () => {
    const m = (await alice.post(`/api/chats/${dm}/messages`, { body: 'only hide for alice' })).body.message;
    await alice.del(`/api/messages/${m.id}`);
    assert.ok(!(await alice.get(`/api/chats/${dm}/messages`)).body.messages.some((x) => x.id === m.id));
    assert.ok((await bob.get(`/api/chats/${dm}/messages`)).body.messages.some((x) => x.id === m.id));
  });

  test('pagination with before/after', async () => {
    for (let i = 0; i < 5; i++) await alice.post(`/api/chats/${dm}/messages`, { body: `page ${i}` });
    const last2 = (await alice.get(`/api/chats/${dm}/messages?limit=2`)).body.messages;
    assert.deepEqual(last2.map((m) => m.body), ['page 3', 'page 4']);
    const older = (await alice.get(`/api/chats/${dm}/messages?limit=2&before=${last2[0].id}`)).body.messages;
    assert.deepEqual(older.map((m) => m.body), ['page 1', 'page 2']);
    const newer = (await alice.get(`/api/chats/${dm}/messages?after=${older[1].id}`)).body.messages;
    assert.deepEqual(newer.map((m) => m.body), ['page 3', 'page 4']);
  });

  test('search finds messages only in my chats', async () => {
    const r = await bob.get('/api/search?q=Thanks');
    assert.ok(r.body.messages.some((m) => m.body === 'Thanks!'));
    const c = await carol.get('/api/search?q=Thanks');
    assert.equal(c.body.messages.length, 0);
    const pct = await bob.get(`/api/search?q=${encodeURIComponent('%')}`);
    assert.equal(pct.status, 200);
  });

  test('non-members cannot read, post, or see chats', async () => {
    assert.equal((await carol.get(`/api/chats/${dm}/messages`)).status, 404);
    assert.equal((await carol.post(`/api/chats/${dm}/messages`, { body: 'intrude' })).status, 404);
    assert.equal((await carol.get(`/api/chats/${dm}`)).status, 404);
    assert.ok(!(await carol.get('/api/chats')).body.chats.some((c) => c.id === dm));
  });

  test('forwarding keeps the original author', async () => {
    const src = (await bob.post(`/api/chats/${dm}/messages`, { body: 'forward me' })).body.message;
    const g = await alice.post('/api/chats/group', { title: 'Fwd target', memberIds: [carol.id] });
    const r = await alice.post('/api/messages/forward', { messageIds: [src.id], toChatIds: [g.body.chat.id] });
    assert.equal(r.status, 200);
    assert.equal(r.body.messages[0].forwardedFrom.name, 'BOB');
    assert.equal(r.body.messages[0].senderId, alice.id);
    // Carol can't forward from a chat she isn't in.
    assert.equal((await carol.post('/api/messages/forward', { messageIds: [src.id], toChatIds: [g.body.chat.id] })).status, 404);
  });
});

describe('languages & translation', () => {
  let dm;
  before(async () => {
    dm = (await alice.post('/api/chats/direct', { userId: bob.id })).body.chat.id;
  });

  test('interface language is saved per user', async () => {
    assert.equal((await alice.get('/api/auth/me')).body.user.language, 'en');
    const r = await alice.req('PATCH', '/api/auth/preferences', { language: 'ru' });
    assert.equal(r.body.user.language, 'ru');
    assert.equal((await alice.get('/api/auth/me')).body.user.language, 'ru');
    assert.equal((await alice.req('PATCH', '/api/auth/preferences', { language: 'de' })).status, 400);
  });

  test('messages translate in both directions and are cached', async () => {
    const en = (await alice.post(`/api/chats/${dm}/messages`, { body: 'Good morning team' })).body.message;
    const ru = (await alice.post(`/api/chats/${dm}/messages`, { body: 'Доброе утро, команда' })).body.message;
    const t1 = await bob.post(`/api/messages/${en.id}/translate`, { target: 'auto' });
    assert.deepEqual([t1.body.translation.target, t1.body.translation.text], ['ru', '[ru] Good morning team']);
    const t2 = await bob.post(`/api/messages/${ru.id}/translate`, {});
    assert.deepEqual([t2.body.translation.target, t2.body.translation.text], ['en', '[en] Доброе утро, команда']);
    const again = await bob.post(`/api/messages/${en.id}/translate`, { target: 'ru' });
    assert.equal(again.body.translation.cached, true);
    // Editing invalidates the cache.
    await alice.patch(`/api/messages/${en.id}`, { body: 'Good evening team' });
    const t3 = await bob.post(`/api/messages/${en.id}/translate`, { target: 'ru' });
    assert.equal(t3.body.translation.text, '[ru] Good evening team');
  });

  test('cannot translate messages from chats you are not in', async () => {
    const m = (await alice.post(`/api/chats/${dm}/messages`, { body: 'secret' })).body.message;
    assert.equal((await carol.post(`/api/messages/${m.id}/translate`, {})).status, 404);
  });

  test('draft translation and per-chat auto-translate setting', async () => {
    const r = await alice.post('/api/translate', { text: 'Привет', target: 'en' });
    assert.equal(r.body.translation.text, '[en] Привет');
    await bob.patch(`/api/chats/${dm}/settings`, { autoTranslate: 'ru' });
    assert.equal((await bob.get('/api/chats')).body.chats.find((c) => c.id === dm).autoTranslate, 'ru');
    await bob.patch(`/api/chats/${dm}/settings`, { muted: true });
    assert.equal((await bob.get('/api/chats')).body.chats.find((c) => c.id === dm).autoTranslate, 'ru');
    await bob.patch(`/api/chats/${dm}/settings`, { autoTranslate: null, muted: false });
    assert.equal((await bob.get('/api/chats')).body.chats.find((c) => c.id === dm).autoTranslate, null);
    assert.equal((await alice.get('/api/config')).body.translation, true);
  });
});

describe('groups & permissions', () => {
  let groupId;

  test('only permitted users can create groups', async () => {
    assert.equal((await bob.post('/api/chats/group', { title: 'Nope' })).status, 403);
    const r = await alice.post('/api/chats/group', { title: 'Sales', memberIds: [bob.id] });
    assert.equal(r.status, 201);
    groupId = r.body.chat.id;
    assert.equal(r.body.chat.myRole, 'owner');
  });

  test('members cannot manage the group; owner can', async () => {
    assert.equal((await bob.post(`/api/chats/${groupId}/members`, { userIds: [carol.id] })).status, 403);
    assert.equal((await bob.patch(`/api/chats/${groupId}`, { title: 'Hacked' })).status, 403);
    const r = await alice.post(`/api/chats/${groupId}/members`, { userIds: [carol.id] });
    assert.deepEqual(r.body.added, [carol.id]);
    const details = await carol.get(`/api/chats/${groupId}`);
    assert.equal(details.body.chat.members.length, 3);
  });

  test('announcement mode: only admins can post', async () => {
    await alice.patch(`/api/chats/${groupId}`, { onlyAdminsPost: true });
    assert.equal((await bob.post(`/api/chats/${groupId}/messages`, { body: 'hi' })).status, 403);
    assert.equal((await alice.post(`/api/chats/${groupId}/messages`, { body: 'Announcement' })).status, 201);
    await alice.patch(`/api/chats/${groupId}/members/${bob.id}`, { role: 'admin' });
    assert.equal((await bob.post(`/api/chats/${groupId}/messages`, { body: 'now I can' })).status, 201);
    await alice.patch(`/api/chats/${groupId}`, { onlyAdminsPost: false });
  });

  test('global admin can manage groups they are not a member of', async () => {
    const list = await admin.get('/api/admin/groups');
    assert.ok(list.body.groups.some((g) => g.id === groupId));
    assert.equal((await admin.del(`/api/chats/${groupId}/members/${carol.id}`)).status, 200);
    assert.equal((await carol.get(`/api/chats/${groupId}/messages`)).status, 404);
    const created = await admin.post('/api/admin/groups', { title: 'All hands', memberIds: [alice.id, bob.id], ownerId: alice.id });
    assert.equal(created.status, 201);
    const chats = (await alice.get('/api/chats')).body.chats;
    assert.equal(chats.find((c) => c.id === created.body.id).myRole, 'owner');
  });

  test('leaving a group', async () => {
    assert.equal((await bob.del(`/api/chats/${groupId}/members/${bob.id}`)).status, 200);
    assert.equal((await bob.get(`/api/chats/${groupId}`)).status, 404);
  });
});

describe('files', () => {
  let dm;
  let fileId;

  before(async () => {
    dm = (await alice.post('/api/chats/direct', { userId: bob.id })).body.chat.id;
  });

  test('upload, attach, and download with permission checks', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 test document')], { type: 'application/pdf' }), 'report.pdf');
    const up = await alice.req('POST', `/api/chats/${dm}/files`, fd);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.file.kind, 'document');
    fileId = up.body.file.id;

    // Not yet attached to a message: only the uploader can fetch it.
    assert.equal((await bob.req('GET', `/api/files/${fileId}`, null, { raw: true })).status, 404);

    const msg = await alice.post(`/api/chats/${dm}/messages`, { fileId, body: 'Q3 report' });
    assert.equal(msg.status, 201);
    assert.equal(msg.body.message.type, 'file');
    assert.equal(msg.body.message.file.name, 'report.pdf');

    const dl = await bob.req('GET', `/api/files/${fileId}`, null, { raw: true });
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), '%PDF-1.4 test document');
    assert.match(dl.headers.get('content-disposition'), /inline; filename="report.pdf"/);

    assert.equal((await carol.req('GET', `/api/files/${fileId}`, null, { raw: true })).status, 404);
    assert.equal((await new Client().req('GET', `/api/files/${fileId}`, null, { raw: true })).status, 401);
  });

  test('dangerous types are forced to download', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
    const up = await alice.req('POST', `/api/chats/${dm}/files`, fd);
    await alice.post(`/api/chats/${dm}/messages`, { fileId: up.body.file.id });
    const dl = await bob.req('GET', `/api/files/${up.body.file.id}`, null, { raw: true });
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
  });

  test('voice messages', async () => {
    const fd = new FormData();
    fd.append('kind', 'voice');
    fd.append('duration', '3.5');
    fd.append('waveform', JSON.stringify([0.1, 0.5, 0.9]));
    fd.append('file', new Blob([Buffer.alloc(2000, 1)], { type: 'audio/webm;codecs=opus' }), 'voice.webm');
    const up = await alice.req('POST', `/api/chats/${dm}/files`, fd);
    assert.equal(up.body.file.kind, 'voice');
    const msg = await alice.post(`/api/chats/${dm}/messages`, { fileId: up.body.file.id });
    assert.equal(msg.body.message.type, 'voice');
    assert.equal(msg.body.message.file.duration, 3.5);
  });

  test('size limit is enforced', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(1024 * 1024 + 10)], { type: 'application/zip' }), 'big.zip');
    const up = await alice.req('POST', `/api/chats/${dm}/files`, fd);
    assert.equal(up.status, 413);
  });

  test('cannot attach someone else\'s upload', async () => {
    const r = await bob.post(`/api/chats/${dm}/messages`, { fileId });
    assert.equal(r.status, 400);
  });
});

describe('calls (signaling)', () => {
  test('invite, accept, relay signals, hang up, and a call log message', async () => {
    const dm = (await alice.post('/api/chats/direct', { userId: bob.id })).body.chat.id;
    const a = await alice.socket();
    const b = await bob.socket();
    const incoming = waitFor(b, 'call:incoming');
    const inv = await a.emitWithAck('call:invite', { chatId: dm, video: true });
    assert.ok(inv.callId, JSON.stringify(inv));
    const inc = await incoming;
    assert.equal(inc.from.id, alice.id);
    assert.equal(inc.video, true);

    const accepted = waitFor(a, 'call:accepted');
    assert.deepEqual(await b.emitWithAck('call:accept', { callId: inv.callId }), { ok: true });
    await accepted;

    const sig = waitFor(b, 'call:signal');
    a.emit('call:signal', { callId: inv.callId, data: { type: 'offer', sdp: 'v=0' } });
    assert.deepEqual((await sig).data, { type: 'offer', sdp: 'v=0' });

    const log = waitFor(a, 'message:new', (m) => m.type === 'call');
    const ended = waitFor(b, 'call:ended');
    a.emit('call:end', { callId: inv.callId });
    await ended;
    const m = await log;
    assert.equal(m.meta.status, 'completed');
    assert.equal(m.meta.video, true);
  });

  test('declined call', async () => {
    const dm = (await alice.post('/api/chats/direct', { userId: bob.id })).body.chat.id;
    const a = await alice.socket();
    const b = await bob.socket();
    const incoming = waitFor(b, 'call:incoming');
    const inv = await a.emitWithAck('call:invite', { chatId: dm, video: false });
    await incoming;
    const ended = waitFor(a, 'call:ended');
    b.emit('call:reject', { callId: inv.callId });
    assert.equal((await ended).reason, 'declined');
  });

  test('group chats and non-members cannot place calls', async () => {
    const g = (await alice.post('/api/chats/group', { title: 'Call group', memberIds: [bob.id] })).body.chat.id;
    const a = await alice.socket();
    assert.ok((await a.emitWithAck('call:invite', { chatId: g })).error);
    const dm = (await alice.post('/api/chats/direct', { userId: bob.id })).body.chat.id;
    const c = await carol.socket();
    assert.ok((await c.emitWithAck('call:invite', { chatId: dm })).error);
  });

  test('ICE configuration endpoint', async () => {
    const r = await alice.get('/api/calls/ice');
    assert.ok(r.body.iceServers.length >= 1);
  });
});

describe('admin lifecycle', () => {
  test('presence: online and last seen', async () => {
    const dave = await makeEmployee(admin, 'dave');
    const watcher = await alice.socket();
    const online = waitFor(watcher, 'presence', (p) => p.userId === dave.id && p.online);
    const s = await dave.socket();
    await online;
    assert.ok((await alice.get('/api/presence')).body.online.includes(dave.id));
    const offline = waitFor(watcher, 'presence', (p) => p.userId === dave.id && !p.online);
    s.close();
    const p = await offline;
    assert.ok(p.lastSeenAt);
  });

  test('deactivation revokes sessions and live sockets immediately; reactivation restores login', async () => {
    const erin = await makeEmployee(admin, 'erin');
    const s = await erin.socket();
    const dropped = new Promise((resolve) => s.on('disconnect', resolve));
    assert.equal((await admin.post(`/api/admin/users/${erin.id}/deactivate`)).status, 200);
    await dropped;
    assert.equal((await erin.get('/api/chats')).status, 401);
    const relog = await new Client().post('/api/auth/login', { username: 'erin', password: erin.password });
    assert.equal(relog.status, 401);
    assert.equal((await admin.post(`/api/admin/users/${erin.id}/reactivate`)).status, 200);
    await login('erin', erin.password);
  });

  test('removal revokes access but keeps business history', async () => {
    const frank = await makeEmployee(admin, 'frank');
    const dm = (await frank.post('/api/chats/direct', { userId: alice.id })).body.chat.id;
    await frank.post(`/api/chats/${dm}/messages`, { body: 'Invoice #42 approved' });
    const g = (await alice.post('/api/chats/group', { title: 'Ops', memberIds: [frank.id] })).body.chat.id;

    assert.equal((await admin.del(`/api/admin/users/${frank.id}`)).status, 200);
    assert.equal((await frank.get('/api/chats')).status, 401);
    assert.equal((await new Client().post('/api/auth/login', { username: 'frank', password: frank.password })).status, 401);

    const history = (await alice.get(`/api/chats/${dm}/messages`)).body.messages;
    assert.ok(history.some((m) => m.body === 'Invoice #42 approved'));
    const members = (await alice.get(`/api/chats/${g}`)).body.chat.members;
    assert.ok(!members.some((m) => m.id === frank.id));
    assert.equal((await alice.post(`/api/chats/${dm}/messages`, { body: 'hello?' })).status, 403);
  });

  test('admin password reset forces change and logs out', async () => {
    const r = await admin.post(`/api/admin/users/${carol.id}/reset-password`);
    assert.ok(r.body.tempPassword);
    assert.equal((await carol.get('/api/chats')).status, 401);
    const c = await login('carol', r.body.tempPassword);
    assert.equal((await c.get('/api/auth/me')).body.user.mustChangePassword, true);
  });

  test('retention policy deletes old messages', async () => {
    const dm = (await alice.post('/api/chats/direct', { userId: bob.id })).body.chat.id;
    const m = (await alice.post(`/api/chats/${dm}/messages`, { body: 'ancient' })).body.message;
    await pool.query(`UPDATE messages SET created_at = now() - interval '400 days' WHERE id = $1`, [m.id]);
    await admin.req('PUT', '/api/admin/settings', { retentionDays: 365 });
    const r = await admin.post('/api/admin/retention/run');
    assert.ok(r.body.deletedMessages >= 1);
    assert.equal((await pool.query('SELECT 1 FROM messages WHERE id = $1', [m.id])).rowCount, 0);
    await admin.req('PUT', '/api/admin/settings', { retentionDays: 0 });
  });

  test('audit log records admin actions', async () => {
    const r = await admin.get('/api/admin/audit');
    const actions = r.body.entries.map((e) => e.action);
    for (const a of ['user_created', 'user_deactivated', 'user_removed', 'password_reset']) assert.ok(actions.includes(a), a);
  });
});
