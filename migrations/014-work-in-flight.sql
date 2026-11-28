-- Work in flight: what each participant is doing right now (working, waiting or idle, and on what).
-- One row per participant, kept until it changes. Additive and idempotent; the app also runs this
-- on first request. Going back to an earlier version leaves the table unused; nothing else reads it.
CREATE TABLE IF NOT EXISTS participant_flight (
  participant TEXT PRIMARY KEY CONSTRAINT participant_flight_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  state       TEXT NOT NULL CHECK (state IN ('working', 'waiting', 'idle')),
  text        TEXT NOT NULL CHECK (char_length(text) <= 80 AND (state = 'idle' OR char_length(text) >= 1)),
  since       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
