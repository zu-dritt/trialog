-- Rooms: more than one stream in one hub. Additive and idempotent; the app also runs this on
-- first request.
-- The room `main` always exists, and every message from before rooms is in it: the new column's
-- default puts it there without rewriting a row. Message ids stay global across rooms, so
-- "since=<id>" keeps working. A room's id has the shape of a participant's name.
CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY CONSTRAINT rooms_id_shape CHECK (id ~ '^[a-z][a-z0-9-]{0,23}$'),
  name       TEXT NOT NULL CONSTRAINT rooms_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL CONSTRAINT rooms_created_by_shape CHECK (created_by ~ '^[a-z][a-z0-9-]{0,23}$')
);

INSERT INTO rooms (id, name, created_by) VALUES ('main', 'Main', 'hub') ON CONFLICT (id) DO NOTHING;

-- The column is only added when it is missing. A plain ADD COLUMN IF NOT EXISTS would ask for an
-- exclusive lock on the table every time, even with nothing to do.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'room'
  ) THEN
    ALTER TABLE messages ADD COLUMN room TEXT NOT NULL DEFAULT 'main'
      CONSTRAINT messages_room_exists REFERENCES rooms (id);
  END IF;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS messages_room_id ON messages (room, id);
