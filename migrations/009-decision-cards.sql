-- Decision cards. Additive and idempotent; the app also runs this on first request.
-- One card per message, one position per (card, participant). Names have the same
-- shape as every other stored participant name. An Object must include a note.
CREATE TABLE IF NOT EXISTS decision_cards (
  id          TEXT PRIMARY KEY,
  message_id  BIGINT NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  creator     TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  agreed_at   TIMESTAMPTZ,
  CONSTRAINT decision_cards_creator_shape CHECK (creator ~ '^[a-z][a-z0-9-]{0,23}$'),
  CONSTRAINT decision_cards_id_shape CHECK (id ~ '^decision_[a-z0-9]{8,48}$')
);

CREATE TABLE IF NOT EXISTS decision_positions (
  card_id     TEXT NOT NULL REFERENCES decision_cards (id) ON DELETE CASCADE,
  participant TEXT NOT NULL,
  stance      TEXT NOT NULL CHECK (stance IN ('agree', 'object')),
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, participant),
  CONSTRAINT decision_positions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
  CONSTRAINT decision_positions_object_has_note CHECK (stance = 'agree' OR (note IS NOT NULL AND char_length(btrim(note)) > 0))
);

CREATE INDEX IF NOT EXISTS decision_cards_message_id ON decision_cards (message_id);
