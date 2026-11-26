-- Read positions. Additive and idempotent; the app also runs this on first request.
-- One row per participant: the highest message id they have read. There is no room
-- column, so a later rooms change can add one without renaming what is already here.
-- The position only moves forward; that rule is applied in the store, not as a check.
CREATE TABLE IF NOT EXISTS read_positions (
  participant TEXT NOT NULL,
  up_to       BIGINT NOT NULL REFERENCES messages (id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (participant),
  CONSTRAINT read_positions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  CONSTRAINT read_positions_up_to_positive CHECK (up_to > 0)
);

CREATE INDEX IF NOT EXISTS read_positions_up_to ON read_positions (up_to);
