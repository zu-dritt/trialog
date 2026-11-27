-- Roadmap cards with a description and pictures, so an idea can be told in full: what the
-- orchestrator means, with a screenshot of an app he likes (playground #636, the Compose window).
-- And a reviewer, so a card says «Claude builds · Grok reviews» (#641).
-- Additive and idempotent; the app also runs this on first request. Existing rows are not touched:
-- pictures are linked to a card in a table of their own. Going back leaves both unused.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000);
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS reviewer TEXT CONSTRAINT roadmap_items_reviewer_shape CHECK (reviewer ~ '^[a-z][a-z0-9-]{0,23}$');
CREATE TABLE IF NOT EXISTS roadmap_pictures (
  attachment_id    TEXT PRIMARY KEY REFERENCES attachments (id) ON DELETE CASCADE,
  roadmap_item_id  TEXT NOT NULL REFERENCES roadmap_items (id) ON DELETE CASCADE,
  position         SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS roadmap_pictures_item ON roadmap_pictures (roadmap_item_id, position);
