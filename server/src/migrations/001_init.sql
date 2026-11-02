-- Core schema for TeamChat.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id                    BIGSERIAL PRIMARY KEY,
  username              TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'removed')),
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  can_create_groups     BOOLEAN NOT NULL DEFAULT FALSE,
  can_start_direct      BOOLEAN NOT NULL DEFAULT TRUE,
  title                 TEXT NOT NULL DEFAULT '',
  avatar_color          SMALLINT NOT NULL DEFAULT 0,
  last_seen_at          TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at            TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT NOT NULL DEFAULT '',
  ip            TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE chats (
  id               BIGSERIAL PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  title            TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  -- For direct chats: "<minUserId>:<maxUserId>" so a pair only ever has one chat.
  direct_key       TEXT UNIQUE,
  only_admins_post BOOLEAN NOT NULL DEFAULT FALSE,
  members_can_add  BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_color     SMALLINT NOT NULL DEFAULT 0,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ
);

CREATE TABLE chat_members (
  chat_id               BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Receipt cursors: message ids are monotonic, so "everything <= id" is delivered/read.
  last_delivered_id     BIGINT NOT NULL DEFAULT 0,
  last_read_id          BIGINT NOT NULL DEFAULT 0,
  muted                 BOOLEAN NOT NULL DEFAULT FALSE,
  pinned                BOOLEAN NOT NULL DEFAULT FALSE,
  archived              BOOLEAN NOT NULL DEFAULT FALSE,
  -- Messages with id <= cleared_before_id are hidden for this member ("clear history").
  cleared_before_id     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_members_user ON chat_members (user_id);

CREATE TABLE files (
  id            BIGSERIAL PRIMARY KEY,
  uploader_id   BIGINT NOT NULL REFERENCES users(id),
  chat_id       BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL UNIQUE,
  file_name     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'voice', 'document')),
  width         INT,
  height        INT,
  duration_sec  REAL,
  waveform      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_chat ON files (chat_id);

CREATE TABLE messages (
  id                 BIGSERIAL PRIMARY KEY,
  chat_id            BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id          BIGINT REFERENCES users(id),
  client_id          TEXT,
  type               TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'file', 'voice', 'system', 'call')),
  body               TEXT NOT NULL DEFAULT '',
  file_id            BIGINT REFERENCES files(id) ON DELETE SET NULL,
  reply_to_id        BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  forwarded_from_id  BIGINT REFERENCES users(id),
  forwarded_name     TEXT,
  meta               JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at          TIMESTAMPTZ,
  -- Soft delete: hidden from users, retained for the configured retention period.
  deleted_at         TIMESTAMPTZ,
  deleted_by         BIGINT REFERENCES users(id)
);
CREATE INDEX messages_chat_id ON messages (chat_id, id DESC);
CREATE UNIQUE INDEX messages_client_id ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX messages_body_trgm ON messages USING gin (body gin_trgm_ops);
CREATE INDEX messages_created ON messages (created_at);

CREATE TABLE message_hidden (
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE message_reactions (
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE pinned_messages (
  chat_id     BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by   BIGINT REFERENCES users(id),
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);
INSERT INTO settings (key, value) VALUES ('retention_days', '0');

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   BIGINT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
CREATE INDEX messages_file ON messages (file_id) WHERE file_id IS NOT NULL;
