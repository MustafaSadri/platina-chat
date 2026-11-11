# TeamChat

A private, Telegram-style business messenger: real-time private and group chats, files, voice messages,
1:1 audio/video calls, English/Russian interface with EN⇄RU message translation, and an admin panel.
There is no public sign-up: the administrator creates every account.

- **Stack:** Node.js 20 · Express · Socket.IO · PostgreSQL (Neon) · Cloudflare R2 · WebRTC · React 18 + Vite
- **Clients:** any modern browser on desktop, Android and iPhone (installable as an app from the browser)
- **Hosting:** a single Render web service, auto-deployed from GitHub

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and data model.

---

## Features

| Area | What works |
| --- | --- |
| Messaging | Private chats, groups, real-time delivery, persistent history, edit, delete (for me / for everyone), reply, forward, emoji reactions, pinned messages, multi-select |
| Status | Sent ✓ / delivered ✓✓ / read (blue ✓✓) receipts, online + "last seen", typing and "recording voice" indicators, unread counters |
| Search | Global search (chats, people, messages) and in-chat search with jump-to-message |
| Media | Images, videos, PDFs, documents, any file up to `MAX_UPLOAD_MB`; voice messages with waveform; drag & drop and paste |
| Calls | 1:1 and group audio and video calls (WebRTC), mute/camera toggle, call log in chat |
| Notifications | Sound + browser notifications; Web Push when the app is closed (needs VAPID keys) |
| Languages | English and Russian interface (auto-detected, switchable, saved per account) |
| Translation | Translate any text message EN⇄RU, per-chat automatic translation of incoming messages, translate your draft before sending |
| Admin | Create employees with temporary passwords, edit roles/permissions, reset passwords, deactivate/reactivate, remove; manage groups, members and roles; retention policy; audit log |
| UX | Light/dark/system theme, responsive desktop/tablet/phone layouts, installable PWA |

### Not included (be aware)

- **Group calls** connect every participant directly to every other one, so they're limited to
  8 people, and quality depends on each person's upload speed.
- **Answer and Decline buttons on call notifications** work on Android and desktop. iPhones don't
  support notification buttons: tapping the notification opens the app on its Accept / Decline screen.
- **No end-to-end encryption.** Traffic is encrypted in transit (HTTPS/WSS) and stored on your servers;
  the server can read messages. This is typical for business messengers with retention requirements.
- **Translation sends message text to the provider you configure** (DeepL, Google or LibreTranslate).
  It is off until you set `TRANSLATE_PROVIDER`.
- **Push notifications on iPhone** require iOS 16.4+ and the app added to the Home Screen.
- **Calls can't ring like a phone call in a web app.** While a call rings, the app sends a notification
  every 7 seconds. A true full-screen ringing call on iPhone needs a native app (CallKit and VoIP push).

---

## 1. Run locally

Requirements: Node.js 20+, Git. A database is optional for local development: the project can start
an embedded PostgreSQL for you.

```bash
npm install
cp .env.example .env            # Windows: copy .env.example .env
```

Edit `.env` for local use:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:54320/postgres
DATABASE_SSL=false
APP_URL=http://localhost:3000
STORAGE_DRIVER=local
```

```bash
npm run db:local                 # terminal 1 – embedded PostgreSQL in ./data/pg (or use a Neon dev branch)
npm run create-admin -- admin "Your Name"   # prints a temporary password
npm run build && npm start       # terminal 2 – http://localhost:3000
```

For frontend development with hot reload, run `npm run dev` (API on :3000) and `npm run dev:client`
(Vite on :5173, proxies `/api` and `/socket.io`).

### Tests

```bash
npm test                         # 70 API/WebSocket integration tests against a real embedded PostgreSQL
node e2e/smoke.mjs <admin> <password> http://localhost:3000   # browser test (needs Chrome + running server)
```

The browser test drives two Chrome sessions (desktop admin, iPhone-sized employee) through onboarding,
messaging, receipts, typing, file sharing, reactions, a real WebRTC call, the Russian interface,
translation and deactivation. Translation steps run when the server has a provider; for local testing
you can start the server with `TRANSLATE_PROVIDER=test` (a fake provider that only works outside production).

---

## 2. Create the cloud services

### Neon PostgreSQL (database)
1. Sign up at <https://neon.tech> → **New project** (use the same region as Render: this project uses AWS US East 2 / Ohio).
2. Create a database, e.g. `teamchat`.
3. On the dashboard, open **Connect** and copy two connection strings:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (pooling off) → `DATABASE_URL_UNPOOLED` (used for migrations)
4. Backups: Neon keeps point-in-time history automatically (length depends on your plan). For extra
   copies, see the nightly backup workflow in step 6.

### Cloudflare R2 (file storage)
1. Cloudflare dashboard → **R2** → **Create bucket** (e.g. `teamchat-files`). Keep it **private**
   (do not enable public access — the app hands out 60-second signed links after checking permissions).
2. **R2 → Manage API tokens → Create API token** with *Object Read & Write* on that bucket.
3. Note: Account ID, Access Key ID, Secret Access Key.
   - `S3_BUCKET=teamchat-files`
   - `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
4. No CORS configuration is needed: uploads go through the app, downloads are plain redirects.

### TURN for calls (recommended)
Calls connect peer-to-peer with STUN. On strict corporate or mobile networks a TURN relay is required.
- **Cloudflare Realtime TURN:** Cloudflare dashboard → **Realtime → TURN Server → Create** → copy the
  *Turn Token ID* and *API Token* → `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`.
- Or any TURN provider / your own coturn: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.

### Translation (optional)
- **DeepL** (best EN⇄RU quality; free tier available): create an API key at <https://www.deepl.com/pro-api> →
  `TRANSLATE_PROVIDER=deepl`, `DEEPL_API_KEY=...` (free keys end in `:fx` and are detected automatically).
- **Google Cloud Translation:** `TRANSLATE_PROVIDER=google`, `GOOGLE_TRANSLATE_API_KEY=...`
- **Self-hosted LibreTranslate** (keeps text in your infrastructure): `TRANSLATE_PROVIDER=libretranslate`,
  `LIBRETRANSLATE_URL=https://translate.yourcompany.com`.

Translations are cached in the database, so each message is sent to the provider at most once per language.

### Web Push (optional)
```bash
npx web-push generate-vapid-keys
```
Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:you@yourcompany.com`.

---

## 3. Put the code on GitHub

```bash
git init -b main          # already done if you received this as a repository
git add .
git commit -m "Initial commit"
# Create an empty PRIVATE repository on github.com (no README), then:
git remote add origin https://github.com/<you>/teamchat.git
git push -u origin main
```

`.env` is in `.gitignore` — secrets never go to GitHub. Only `.env.example` (no real values) is committed.
CI (`.github/workflows/ci.yml`) runs the test suite and the build on every push and pull request.

---

## 4. Deploy on Render

1. <https://dashboard.render.com> → **New → Blueprint** → connect your GitHub account → choose the repository.
   Render reads `render.yaml` and creates the `platina-chat` web service.
2. Render asks for every variable marked `sync: false`. Fill in at least:

   | Variable | Value |
   | --- | --- |
   | `APP_URL` | `https://platina-chat.onrender.com` for now (change after adding your domain) |
   | `DATABASE_URL` | Neon pooled string |
   | `DATABASE_URL_UNPOOLED` | Neon direct string |
   | `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | R2 values |

   Leave the optional ones (TURN, translation, VAPID) empty if you don't use them yet.
3. **Apply.** Build: `npm ci && npm run build`. Start: `npm start` (applies database migrations, then starts).
   Health check: `/healthz`.
4. Choose an instance type that does not sleep (**Starter** or higher). Free instances spin down when
   idle, which disconnects everyone's real-time connection.
5. **Auto-deploy** is on: every push to `main` redeploys.

### Create the first administrator
Render dashboard → service → **Shell**:
```bash
npm run create-admin -- admin "Your Name"
```
Sign in with the printed temporary password; you'll be asked to set a new one. Then open
**☰ → Admin panel → Add employee** to create accounts and share each temporary password securely.
(Without shell access, run the same command locally with `.env` pointing at the Neon database.)

---

## 5. Custom domain with HTTPS

1. Render → service → **Settings → Custom Domains → Add** `chat.yourcompany.com`.
2. At your DNS provider add the record Render shows (a `CNAME` to `platina-chat.onrender.com`).
3. Render issues and renews the TLS certificate automatically.
4. Update `APP_URL=https://chat.yourcompany.com` in Render → **Environment** (triggers a redeploy).

In production the app forces HTTPS, sends HSTS, and sets `Secure`, `HttpOnly`, `__Host-` session cookies.

---

## 6. Operations

- **Backups:** Neon point-in-time restore + optional nightly `pg_dump` to R2 via
  `.github/workflows/backup.yml` (add the secrets listed in that file and a repository variable
  `BACKUPS_ENABLED=true`). Turn on R2 bucket versioning/lifecycle rules if you want file history too.
- **Retention:** Admin panel → Retention. `0` keeps history forever; otherwise messages (including ones
  users deleted) and their files are purged after N days.
- **Removing an employee:** access is revoked instantly (sessions deleted, live connections closed),
  they leave all groups, and their past messages remain for the retention period.
- **Scaling:** one instance handles a typical company. For several instances set `REDIS_URL`
  (Render Key Value) — see the scaling notes in the architecture doc.
- **Logs:** Render → service → Logs.

## Environment variables

All variables are documented in [.env.example](.env.example).

## Security summary

- Passwords hashed with bcrypt (cost 12); minimum 10 characters with letters and numbers.
- Opaque random session tokens, stored only as SHA-256 hashes; every request re-checks that the account is active.
- Server-side authorization on every chat, message and file; non-members get `404`.
- Files in a private bucket; downloads only after a permission check via 60-second signed URLs;
  risky file types are always served as downloads.
- Rate limits on sign-in, API, uploads, translation and WebSocket events; Origin checks against CSRF;
  Helmet security headers with a strict Content-Security-Policy.
- Audit log of administrative actions and sign-ins.
- No secrets in the frontend bundle or the repository.
