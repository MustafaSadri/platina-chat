-- When each member's read cursor moved, so a sender can see who read a message and at what time.
-- A member read message N at the earliest read_at whose up_to_id >= N.
CREATE TABLE message_reads (
  chat_id   BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  up_to_id  BIGINT NOT NULL,
  read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id, up_to_id)
);
CREATE INDEX message_reads_read_at ON message_reads (read_at);
