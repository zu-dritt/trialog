-- Progress on roadmap cards: how far the owner is (0–100) and a short status line, so the
-- orchestrator can see where a «Now» card stands without asking. Additive and idempotent; the app
-- also runs this on first request. Going back leaves the two columns unused.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS progress SMALLINT CHECK (progress IS NULL OR progress BETWEEN 0 AND 100);
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT '' CHECK (char_length(status) <= 80);
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ;
