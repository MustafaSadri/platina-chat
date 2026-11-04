# Architecture

## Overview

```
 Browser / installed PWA (desktop · Android · iPhone)
   │  HTTPS (REST)            WSS (Socket.IO)              WebRTC media (P2P or via TURN)
   ▼                          ▼                                    ▲
 ┌──────────────────── Render web service (Node 20) ─────────────┐ │
 │ Express API ─ auth, chats, messages, files, admin, translate  │ │
 │ Socket.IO   ─ live events, presence, typing, call signaling ──┼─┘
 │ Static SPA  ─ React build (dist/)                             │
 └───────┬──────────────┬───────────────┬───────────────┬────────┘
         │ SQL (TLS)    │ S3 API        │ HTTPS         │ (optional)
         ▼              ▼               ▼               ▼
   Neon PostgreSQL   Cloudflare R2   TURN credentials,  Redis
   (all data)        (private files) translation, push  (multi-instance)
```

A single service keeps the API, WebSockets and web app on one origin, so cookies, CORS and the
Content-Security-Policy stay simple and there is one thing to deploy.

### Why Neon PostgreSQL
The data is relational: memberships, roles, per-member read cursors, reactions, pins and audit
records all need transactions, foreign keys and fast joins. Postgres also provides trigram search
(`pg_trgm`) for message search. Neon adds managed backups/point-in-time restore and branching for
staging. No other database was a better fit, so Neon stays as specified.

## Project layout

```
server/src/
  index.js            bootstrap (migrations → storage check → HTTP + Socket.IO)
  app.js              Express app, security headers, routing, static SPA
  config.js           environment configuration
  db.js / migrate.js  pg pool, transactional SQL migrations (advisory-locked)
  middleware.js       session loading, auth guards, CSRF origin check, validation, errors
  migrations/*.sql    schema
  routes/             auth, chats (+messages, translate), files, admin, misc
  services/           auth, chats (core domain), storage (local/R2), push, retention, ice, translate, audit
  realtime/           bus (emit helpers), socket (auth, presence, typing, receipts), calls (signaling)
  scripts/            create-admin, local-db
server/test/          integration tests (real Postgres via embedded-postgres)
client/src/
  lib/                api, store (zustand), socket, call (WebRTC), notify, i18n, format
  components/         Sidebar, ChatView, Message, Composer, ChatInfo, Modals, Admin, CallOverlay, Auth
e2e/smoke.mjs         two-browser end-to-end test (puppeteer-core + Chrome)
```

## Data model (main tables)

| Table | Purpose |
| --- | --- |
| `users` | accounts, role (`admin`/`employee`), status (`active`/`deactivated`/`removed`), permissions, language |
| `sessions` | SHA-256 hashes of session tokens, expiry, device info |
| `chats` | `direct` (unique `direct_key` per pair) or `group` with posting/adding policies |
| `chat_members` | role in chat, **read/delivered cursors**, mute/pin/archive, auto-translate target |
| `messages` | text/file/voice/system/call; reply, forward origin, edit and soft-delete markers, `client_id` for idempotency |
| `files` | storage key, metadata, waveform for voice |
| `message_reactions`, `pinned_messages`, `message_hidden` | reactions, pins, "delete for me" |
| `message_translations` | translation cache per message and language |
| `push_subscriptions`, `settings`, `audit_log` | Web Push, retention setting, admin audit trail |

**Receipts** use cursors instead of a row per message per reader: message ids only grow, so
"delivered/read up to id N" per member is enough. A message is *delivered* when any other member's
delivered cursor reaches it and *read* when any other member's read cursor does (Telegram semantics).

## Key flows

- **Send:** client generates a `clientId`, shows the message immediately, `POST /api/chats/:id/messages`.
  The insert is idempotent on `(sender, clientId)`, so retries after network loss never duplicate.
  The server emits `message:new` to every member's room; recipients acknowledge with `delivered`.
- **Reconnect / sync:** on reconnect the client reloads chat summaries and fetches `?after=<lastId>`
  for each open conversation, then retries queued sends. History therefore survives reloads,
  device switches and restarts — the database is the source of truth.
- **Revocation:** every HTTP request and socket handshake re-validates the session *and* that the user
  is `active`. Deactivate/remove deletes sessions and force-disconnects live sockets immediately.
- **Files:** multipart upload streams through the server into R2 (size-limited). Downloads check
  that the user uploaded the file or belongs to a chat with a visible message referencing it, then
  redirect to a 60-second presigned URL. Only safe media types render inline.
- **Calls:** Socket.IO relays invite/accept/reject/SDP/ICE between exactly two sockets; media is
  peer-to-peer (or relayed by TURN). A call record is written to the chat when the call ends. If a
  socket drops during an answered call, the client has a grace period to reattach with `call:rejoin`.
- **Notifications:** clients report whether the app is on screen. Anyone not looking at it gets a Web
  Push (a connected socket isn't enough, since phones keep sockets open in the background). While a
  call rings the push repeats, and people opening the app are sent the ringing call on connect.
  Each subscription belongs to a session, so ending the session stops pushes to that device.
- **Translation:** `POST /api/messages/:id/translate` checks visibility, detects EN/RU by script, calls
  the provider, caches the result; edits clear the cache. Auto-translate is a per-member chat setting
  applied by the client as messages arrive.

## Scaling notes

- One instance comfortably serves hundreds of concurrent users.
- With `REDIS_URL`, Socket.IO uses the Redis adapter, so events and presence (`fetchSockets`) work across instances.
- Active-call state lives in the instance's memory. When running several instances, enable session
  affinity or keep a single instance for calls; moving call state into Redis is the next step if needed.
- Neon's pooled endpoint (PgBouncer) is used for app queries; migrations use the direct endpoint.
