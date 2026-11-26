-- Wake-up targets and delivery status, for every agent. Additive and idempotent; the app also
-- runs this on first request. A target is one participant's webhook URL and secret. Secrets are
-- stored so the hub can sign a request, and are never returned after they are set. A delivery
-- row is one (message, participant) the hub tried to wake, with its status.
CREATE TABLE IF NOT EXISTS wake_targets (
  participant TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wake_targets_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  CONSTRAINT wake_targets_url_https CHECK (url ~ '^https://' AND char_length(url) BETWEEN 8 AND 2048),
  CONSTRAINT wake_targets_secret_length CHECK (char_length(secret) BETWEEN 16 AND 256)
);

CREATE TABLE IF NOT EXISTS wake_deliveries (
  message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  participant TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts    INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, participant),
  CONSTRAINT wake_deliveries_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$')
);

CREATE INDEX IF NOT EXISTS wake_deliveries_participant_message ON wake_deliveries (participant, message_id);
CREATE INDEX IF NOT EXISTS wake_deliveries_pending ON wake_deliveries (message_id) WHERE status = 'pending';
