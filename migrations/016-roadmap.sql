-- The roadmap: cards in four columns, in an order anyone can change (lib/roadmap.ts). Additive and
-- idempotent; the app also runs this on first request. Going back leaves the table unused.
CREATE TABLE IF NOT EXISTS roadmap_items (
  id          TEXT PRIMARY KEY CHECK (id ~ '^rm_[a-z0-9]{8,32}$'),
  col         TEXT NOT NULL CHECK (col IN ('done', 'now', 'next', 'later')),
  position    INT NOT NULL,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  note        TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
  owner       TEXT CONSTRAINT roadmap_items_owner_shape CHECK (owner ~ '^[a-z][a-z0-9-]{0,23}$'),
  updated_by  TEXT NOT NULL CONSTRAINT roadmap_items_updated_by_shape CHECK (updated_by ~ '^[a-z][a-z0-9-]{0,23}$'),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roadmap_items_col_position ON roadmap_items (col, position);
