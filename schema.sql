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
