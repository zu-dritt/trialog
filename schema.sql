CREATE TABLE IF NOT EXISTS messages (
     id         BIGSERIAL PRIMARY KEY,
     sender     TEXT NOT NULL CHECK (sender IN ('grok', 'claude', 'david', 'hub')),
     recipient  TEXT CHECK (recipient IN ('grok', 'claude', 'david')),
     text       TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     pinned_at  TIMESTAMPTZ
   );

CREATE INDEX IF NOT EXISTS messages_sender_created_at ON messages (sender, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS messages_one_welcome ON messages (sender) WHERE sender = 'hub';

CREATE TABLE IF NOT EXISTS webhook_state (
     id               INT PRIMARY KEY CHECK (id = 1),
     last_notified_id BIGINT NOT NULL DEFAULT 0
   );

INSERT INTO webhook_state (id, last_notified_id)
   SELECT 1, coalesce(max(id), 0) FROM messages
   ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS attachments (
     id           TEXT PRIMARY KEY CHECK (id ~ '^att_[a-z0-9]+$'),
     sender       TEXT NOT NULL CHECK (sender IN ('grok', 'claude', 'david')),
     message_id   BIGINT REFERENCES messages (id) ON DELETE CASCADE,
     position     SMALLINT NOT NULL DEFAULT 0,
     content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
     bytes        INT NOT NULL CHECK (bytes > 0 AND bytes <= 4194304),
     width        INT NOT NULL CHECK (width > 0),
     height       INT NOT NULL CHECK (height > 0),
     data         BYTEA CHECK (data IS NULL OR octet_length(data) = bytes),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE INDEX IF NOT EXISTS attachments_message_id ON attachments (message_id);

CREATE INDEX IF NOT EXISTS attachments_sender_created_at ON attachments (sender, created_at);

CREATE TABLE IF NOT EXISTS participant_status (
     participant TEXT PRIMARY KEY CHECK (participant IN ('grok', 'claude', 'david')),
     text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
     expires_at  TIMESTAMPTZ NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE INDEX IF NOT EXISTS participant_status_expires_at ON participant_status (expires_at);

DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'reply_to'
     ) THEN
       ALTER TABLE messages ADD COLUMN reply_to BIGINT REFERENCES messages (id) ON DELETE SET NULL;
     END IF;
   END
   $$;

CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL;
