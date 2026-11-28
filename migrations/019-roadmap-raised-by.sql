-- Who raised each roadmap card, so the orchestrator knows whom to ask without pinging everyone
-- (playground #670). The participant who added the card; set once, never changed by an edit.
-- Additive and idempotent; the app also runs this on first request. Existing cards keep NULL
-- (unknown), and the page shows nothing for them. Going back leaves the column unused.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS raised_by TEXT CONSTRAINT roadmap_items_raised_by_shape CHECK (raised_by ~ '^[a-z][a-z0-9-]{0,23}$');
