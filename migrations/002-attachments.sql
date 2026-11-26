-- Image attachments. Additive and idempotent; the app also runs this on first request.
-- A row is created by an upload (POST /api/attachments) and linked to a message when that message
-- is posted. Uploads that stay unlinked for more than an hour are deleted by the next upload.
-- `data` holds the image after it was re-encoded without metadata, at most 4 MB.
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
