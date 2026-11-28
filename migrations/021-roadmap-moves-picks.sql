-- Why a card in Next is where it is (playground #1327, hub decision 1338). Who last moved a card
-- (a drag, ↑ ↓, the column menu or Build it, never an edit) and when, when it entered Next, and each
-- participant's one pick. Additive and idempotent; the app also runs this on first request.
-- Existing cards keep NULL, and the page shows nothing for them. Going back leaves the columns and
-- the table unused.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS moved_by TEXT CONSTRAINT roadmap_items_moved_by_shape CHECK (moved_by ~ '^[a-z][a-z0-9-]{0,23}$');
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS moved_at TIMESTAMPTZ;
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS entered_next_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS roadmap_picks (
     participant  TEXT PRIMARY KEY CONSTRAINT roadmap_picks_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
     item_id      TEXT NOT NULL REFERENCES roadmap_items (id) ON DELETE CASCADE,
     picked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   );
