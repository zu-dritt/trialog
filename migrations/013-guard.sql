-- The loop and cost guard. Idempotent; the app also runs this on first request.
-- The hub used to have exactly one message, its welcome, and a unique index made sure of it. The
-- guard's notices («Guard: wake-ups paused, …») are messages of the hub too, so that index goes;
-- the app keeps the welcome to one with a lock instead.
-- Going back to a version from before the guard: that version creates the unique index again on
-- its first request, which fails once the hub has posted a notice. Remove those first:
--   DELETE FROM messages WHERE sender = 'hub' AND text LIKE 'Guard: %';
DROP INDEX IF EXISTS messages_one_welcome;

-- The guard counts the agent messages of the last 24 hours on every post and every wake-up. This
-- index keeps that a range read instead of a scan of every message the hub ever had.
CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at);
