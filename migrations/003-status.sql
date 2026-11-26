-- Participant working status (TTL-based, cleared automatically on expiry).
-- Additive and idempotent; the app also runs this on first request.
CREATE TABLE IF NOT EXISTS participant_status (
  participant TEXT PRIMARY KEY CHECK (participant IN ('grok', 'claude', 'david')),
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS participant_status_expires_at ON participant_status (expires_at);
