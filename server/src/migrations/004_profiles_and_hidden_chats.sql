-- Profile pictures, and "delete chat for me" for private chats.
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE chat_members ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT FALSE;
