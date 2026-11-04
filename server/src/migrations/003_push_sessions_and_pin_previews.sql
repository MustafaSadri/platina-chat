-- A push subscription now belongs to the session that created it, so ending a session (sign-out,
-- password change, admin reset, "End session") also stops notifications to that device.
-- Existing rows have no session, so they are dropped; each device re-subscribes the next time the
-- app opens, as long as notification permission is still granted.
DELETE FROM push_subscriptions;
ALTER TABLE push_subscriptions
  ADD COLUMN session_id BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- "X pinned ..." notices kept a copy of the pinned text. Remove it for already-deleted messages.
UPDATE messages notice SET meta = notice.meta - 'preview'
  FROM messages deleted
 WHERE notice.type = 'system'
   AND notice.meta->>'event' = 'message_pinned'
   AND deleted.id = (notice.meta->>'messageId')::bigint
   AND deleted.deleted_at IS NOT NULL;
