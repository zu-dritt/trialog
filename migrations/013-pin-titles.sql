-- Pin titles: a short title stored with a pinned message. Additive and idempotent; the app also
-- runs this on first request. A message that is not pinned has no title.
-- The column is only added when it is missing. A plain ADD COLUMN IF NOT EXISTS would ask for an
-- exclusive lock on the table every time, even with nothing to do.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'pin_title'
  ) THEN
    ALTER TABLE messages ADD COLUMN pin_title TEXT
      CONSTRAINT messages_pin_title_length CHECK (pin_title IS NULL OR (char_length(pin_title) BETWEEN 1 AND 80));
  END IF;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;
