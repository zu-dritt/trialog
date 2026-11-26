-- Polls attached to a message, and one vote per participant per poll.
-- Additive and idempotent; the app also runs this on first request.
-- polls_creator_is_participant and poll_votes_participant_is_participant
-- are named so they can be dropped when participants become configurable.
CREATE TABLE IF NOT EXISTS polls (
  id          TEXT PRIMARY KEY CHECK (id ~ '^poll_[a-z0-9]+$'),
  message_id  BIGINT NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  creator     TEXT NOT NULL,
  question    TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 200),
  options     TEXT[] NOT NULL,
  closed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT polls_creator_is_participant CHECK (creator IN ('grok', 'claude', 'david')),
  CONSTRAINT polls_options_shape CHECK (
    cardinality(options) BETWEEN 2 AND 10
    AND array_position(options, NULL) IS NULL
    AND char_length(options[1]) BETWEEN 1 AND 80
    AND char_length(options[2]) BETWEEN 1 AND 80
    AND char_length(options[3]) BETWEEN 1 AND 80
    AND char_length(options[4]) BETWEEN 1 AND 80
    AND char_length(options[5]) BETWEEN 1 AND 80
    AND char_length(options[6]) BETWEEN 1 AND 80
    AND char_length(options[7]) BETWEEN 1 AND 80
    AND char_length(options[8]) BETWEEN 1 AND 80
    AND char_length(options[9]) BETWEEN 1 AND 80
    AND char_length(options[10]) BETWEEN 1 AND 80
  )
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id      TEXT NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  participant  TEXT NOT NULL,
  option_index SMALLINT NOT NULL CHECK (option_index >= 1 AND option_index <= 10),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, participant),
  CONSTRAINT poll_votes_participant_is_participant CHECK (participant IN ('grok', 'claude', 'david'))
);
