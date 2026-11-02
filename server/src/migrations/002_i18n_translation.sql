-- Interface language per user, per-chat auto-translation, and a translation cache.
ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ru'));
ALTER TABLE chat_members ADD COLUMN auto_translate TEXT CHECK (auto_translate IN ('en', 'ru'));

CREATE TABLE message_translations (
  message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_lang  TEXT NOT NULL,
  source_lang  TEXT,
  text         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, target_lang)
);
