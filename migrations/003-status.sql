-- Participant working status (TTL-based, cleared automatically on expiry).
-- Additive and idempotent; the app also runs this on first request.
-- The check on `participant` listed three names until 004-any-participants.sql; a database made by
-- the earlier version of this file is brought in line by that migration.
CREATE TABLE IF NOT EXISTS participant_status (
  participant TEXT PRIMARY KEY CONSTRAINT participant_status_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS participant_status_expires_at ON participant_status (expires_at);
