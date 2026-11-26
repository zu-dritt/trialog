-- Message reactions. Additive and idempotent; the app also runs this on first request.
-- One row per (message, participant, emoji). The reactor name must have the same
-- shape as any other participant name (`^[a-z][a-z0-9-]{0,23}$`).
CREATE TABLE IF NOT EXISTS reactions (
  message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  participant TEXT NOT NULL,
  emoji       TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, participant, emoji),
  CONSTRAINT reactions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$')
);

-- If an earlier draft of this table listed names, replace that check with the shape check.
-- On a database that already has the shape constraint it only looks, and alters nothing.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(7230421);
  ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_participant_is_participant;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'reactions'::regclass AND conname = 'reactions_participant_shape') THEN
    ALTER TABLE reactions ADD CONSTRAINT reactions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reactions_message_id ON reactions (message_id);
