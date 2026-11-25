-- v2 PR 2: Grok wake-up webhook. Additive and idempotent; the app also runs this on first request.
-- One row holding the id of the last message Grok was woken for.
CREATE TABLE IF NOT EXISTS webhook_state (
  id               INT PRIMARY KEY CHECK (id = 1),
  last_notified_id BIGINT NOT NULL DEFAULT 0
);

-- Starts at the newest message, so history from before the webhook existed never triggers a wake-up.
INSERT INTO webhook_state (id, last_notified_id)
SELECT 1, coalesce(max(id), 0) FROM messages
ON CONFLICT (id) DO NOTHING;
