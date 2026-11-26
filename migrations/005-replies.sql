-- Replies: a message can name the earlier message it answers. Additive and idempotent; the app
-- also runs this on first request.
-- The column is only added when it is missing. A plain ADD COLUMN IF NOT EXISTS would ask for an
-- exclusive lock on the table every time, even with nothing to do.
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
