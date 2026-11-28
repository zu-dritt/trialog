-- The streak: when the orchestrator had to step in, and why. Merges come from GitHub; only the
-- breaks are kept here. Additive and idempotent; the app also runs this on first request. Going back
-- to an earlier version leaves the table unused.
CREATE TABLE IF NOT EXISTS streak_breaks (
  id          BIGSERIAL PRIMARY KEY,
  participant TEXT NOT NULL CONSTRAINT streak_breaks_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  reason      TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
