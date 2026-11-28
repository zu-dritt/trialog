-- Device tokens for iPhone push (playground #1044). Additive and idempotent; the app also runs
-- this on first request. One row per token: who it belongs to, sandbox or production, and when
-- it was last seen or disabled (Apple said the token is gone).
CREATE TABLE IF NOT EXISTS push_devices (
  token        TEXT PRIMARY KEY,
  participant  TEXT NOT NULL,
  platform     TEXT NOT NULL,
  env          TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ,
  CONSTRAINT push_devices_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  CONSTRAINT push_devices_token_shape CHECK (token ~ '^[0-9a-fA-F]{64,256}$'),
  CONSTRAINT push_devices_platform_check CHECK (platform IN ('ios')),
  CONSTRAINT push_devices_env_check CHECK (env IN ('sandbox', 'production'))
);

CREATE INDEX IF NOT EXISTS push_devices_participant ON push_devices (participant) WHERE disabled_at IS NULL;
