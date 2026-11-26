CREATE TABLE IF NOT EXISTS messages (
     id         BIGSERIAL PRIMARY KEY,
     sender     TEXT NOT NULL CONSTRAINT messages_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$'),
     recipient  TEXT CONSTRAINT messages_recipient_shape CHECK (recipient ~ '^[a-z][a-z0-9-]{0,23}$'),
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
     sender       TEXT NOT NULL CONSTRAINT attachments_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$'),
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
     participant TEXT PRIMARY KEY CONSTRAINT participant_status_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
     text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
     expires_at  TIMESTAMPTZ NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE INDEX IF NOT EXISTS participant_status_expires_at ON participant_status (expires_at);

DO $$
   DECLARE old record;
   BEGIN
     PERFORM pg_advisory_xact_lock(7230420);
     FOR old IN
       SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
       WHERE contype = 'c'
         AND conrelid IN ('messages'::regclass, 'attachments'::regclass, 'participant_status'::regclass)
         AND pg_get_constraintdef(oid) LIKE '%''grok''%'
     LOOP
       EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', old.tbl, old.conname);
     END LOOP;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_sender_shape') THEN
       ALTER TABLE messages ADD CONSTRAINT messages_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_recipient_shape') THEN
       ALTER TABLE messages ADD CONSTRAINT messages_recipient_shape CHECK (recipient ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'attachments'::regclass AND conname = 'attachments_sender_shape') THEN
       ALTER TABLE attachments ADD CONSTRAINT attachments_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'participant_status'::regclass AND conname = 'participant_status_participant_shape') THEN
       ALTER TABLE participant_status ADD CONSTRAINT participant_status_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
   END $$;
