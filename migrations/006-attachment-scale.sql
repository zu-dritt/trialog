-- The scale of an image: how many of its pixels make one point on the screen it was taken on.
-- 1 for an ordinary image, 2 or more for a screenshot from a high-density screen. The page uses
-- it to show an image at the size it was taken, not larger.
-- Additive and idempotent; the app also runs this on first request. Images stored before this
-- have scale 1, so they are shown as they were.
-- The column is only added when it is missing. A plain ADD COLUMN IF NOT EXISTS would ask for an
-- exclusive lock on the table every time, even with nothing to do.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'attachments' AND column_name = 'scale'
  ) THEN
    ALTER TABLE attachments ADD COLUMN scale SMALLINT NOT NULL DEFAULT 1
      CONSTRAINT attachments_scale_range CHECK (scale BETWEEN 1 AND 4);
  END IF;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;
