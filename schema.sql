CREATE TABLE IF NOT EXISTS messages (
     id         BIGSERIAL PRIMARY KEY,
     sender     TEXT NOT NULL CONSTRAINT messages_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$'),
     recipient  TEXT CONSTRAINT messages_recipient_shape CHECK (recipient ~ '^[a-z][a-z0-9-]{0,23}$'),
     text       TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     pinned_at  TIMESTAMPTZ
   );

CREATE INDEX IF NOT EXISTS messages_sender_created_at ON messages (sender, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS messages_one_welcome ON messages (sender) WHERE sender = 'hub';

CREATE TABLE IF NOT EXISTS webhook_state (
     id               INT PRIMARY KEY CHECK (id = 1),
     last_notified_id BIGINT NOT NULL DEFAULT 0
   );

INSERT INTO webhook_state (id, last_notified_id)
   SELECT 1, coalesce(max(id), 0) FROM messages
   ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS attachments (
     id           TEXT PRIMARY KEY CHECK (id ~ '^att_[a-z0-9]+$'),
     sender       TEXT NOT NULL CHECK (sender IN ('grok', 'claude', 'david')),
     message_id   BIGINT REFERENCES messages (id) ON DELETE CASCADE,
     position     SMALLINT NOT NULL DEFAULT 0,
     content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
     bytes        INT NOT NULL CHECK (bytes > 0 AND bytes <= 4194304),
     width        INT NOT NULL CHECK (width > 0),
     height       INT NOT NULL CHECK (height > 0),
     data         BYTEA CHECK (data IS NULL OR octet_length(data) = bytes),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE INDEX IF NOT EXISTS attachments_message_id ON attachments (message_id);

CREATE INDEX IF NOT EXISTS attachments_sender_created_at ON attachments (sender, created_at);

CREATE TABLE IF NOT EXISTS participant_status (
     participant TEXT PRIMARY KEY CHECK (participant IN ('grok', 'claude', 'david')),
     text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
     expires_at  TIMESTAMPTZ NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE INDEX IF NOT EXISTS participant_status_expires_at ON participant_status (expires_at);

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

DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'reply_to'
     ) THEN
       ALTER TABLE messages ADD COLUMN reply_to BIGINT REFERENCES messages (id) ON DELETE SET NULL;
     END IF;
   END
   $$;

CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL;

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

DO $$
   DECLARE old record;
   BEGIN
     PERFORM pg_advisory_xact_lock(7230420);
     FOR old IN
       SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
       WHERE contype = 'c'
         AND conrelid IN ('messages'::regclass, 'attachments'::regclass, 'participant_status'::regclass,
                          'polls'::regclass, 'poll_votes'::regclass)
         AND pg_get_constraintdef(oid) LIKE '%''grok''%'
     LOOP
       EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', old.tbl, old.conname);
     END LOOP;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_sender_shape') THEN
       ALTER TABLE messages ADD CONSTRAINT messages_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_recipient_shape') THEN
       ALTER TABLE messages ADD CONSTRAINT messages_recipient_shape CHECK (recipient ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'attachments'::regclass AND conname = 'attachments_sender_shape') THEN
       ALTER TABLE attachments ADD CONSTRAINT attachments_sender_shape CHECK (sender ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'participant_status'::regclass AND conname = 'participant_status_participant_shape') THEN
       ALTER TABLE participant_status ADD CONSTRAINT participant_status_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'polls'::regclass AND conname = 'polls_creator_shape') THEN
       ALTER TABLE polls ADD CONSTRAINT polls_creator_shape CHECK (creator ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'poll_votes'::regclass AND conname = 'poll_votes_participant_shape') THEN
       ALTER TABLE poll_votes ADD CONSTRAINT poll_votes_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
   END $$;

CREATE TABLE IF NOT EXISTS reactions (
     message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     participant TEXT NOT NULL,
     emoji       TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (message_id, participant, emoji),
     CONSTRAINT reactions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$')
   );

DO $$
   BEGIN
     PERFORM pg_advisory_xact_lock(7230421);
     ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_participant_is_participant;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'reactions'::regclass AND conname = 'reactions_participant_shape') THEN
       ALTER TABLE reactions ADD CONSTRAINT reactions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$');
     END IF;
   END $$;

CREATE INDEX IF NOT EXISTS reactions_message_id ON reactions (message_id);

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

CREATE TABLE IF NOT EXISTS read_positions (
     participant TEXT NOT NULL,
     up_to       BIGINT NOT NULL REFERENCES messages (id),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (participant),
     CONSTRAINT read_positions_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
     CONSTRAINT read_positions_up_to_positive CHECK (up_to > 0)
   );

CREATE INDEX IF NOT EXISTS read_positions_up_to ON read_positions (up_to);

CREATE TABLE IF NOT EXISTS wake_targets (
     participant TEXT PRIMARY KEY,
     url         TEXT NOT NULL,
     secret      TEXT NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT wake_targets_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
     CONSTRAINT wake_targets_url_https CHECK (url ~ '^https://' AND char_length(url) BETWEEN 8 AND 2048),
     CONSTRAINT wake_targets_secret_length CHECK (char_length(secret) BETWEEN 16 AND 256)
   );

CREATE TABLE IF NOT EXISTS wake_deliveries (
     message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     participant TEXT NOT NULL,
     status      TEXT NOT NULL,
     attempts    INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     error       TEXT,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (message_id, participant),
     CONSTRAINT wake_deliveries_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$'),
     CONSTRAINT wake_deliveries_status_check CHECK (status IN ('pending', 'sending', 'delivered', 'failed'))
   );

CREATE INDEX IF NOT EXISTS wake_deliveries_participant_message ON wake_deliveries (participant, message_id);

CREATE INDEX IF NOT EXISTS wake_deliveries_pending ON wake_deliveries (message_id) WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS wake_test_events (
     participant TEXT NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT wake_test_events_participant_shape CHECK (participant ~ '^[a-z][a-z0-9-]{0,23}$')
   );

CREATE INDEX IF NOT EXISTS wake_test_events_participant_created ON wake_test_events (participant, created_at);

CREATE TABLE IF NOT EXISTS rooms (
     id         TEXT PRIMARY KEY CONSTRAINT rooms_id_shape CHECK (id ~ '^[a-z][a-z0-9-]{0,23}$'),
     name       TEXT NOT NULL CONSTRAINT rooms_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     created_by TEXT NOT NULL CONSTRAINT rooms_created_by_shape CHECK (created_by ~ '^[a-z][a-z0-9-]{0,23}$')
   );

INSERT INTO rooms (id, name, created_by) VALUES ('main', 'Main', 'hub') ON CONFLICT (id) DO NOTHING;

DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'room'
     ) THEN
       ALTER TABLE messages ADD COLUMN room TEXT NOT NULL DEFAULT 'main'
         CONSTRAINT messages_room_exists REFERENCES rooms (id);
     END IF;
   EXCEPTION WHEN duplicate_column THEN
     NULL;
   END $$;

CREATE INDEX IF NOT EXISTS messages_room_id ON messages (room, id);

DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'read_positions' AND column_name = 'room'
     ) THEN
       ALTER TABLE read_positions ADD COLUMN room TEXT NOT NULL DEFAULT 'main'
         CONSTRAINT read_positions_room_exists REFERENCES rooms (id);
     END IF;
     -- The key is checked by itself, so it is put right whatever state the column was found in.
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'read_positions'::regclass AND contype = 'p'
         AND pg_get_constraintdef(oid) = 'PRIMARY KEY (participant, room)'
     ) THEN
       ALTER TABLE read_positions DROP CONSTRAINT IF EXISTS read_positions_pkey;
       ALTER TABLE read_positions ADD CONSTRAINT read_positions_pkey PRIMARY KEY (participant, room);
     END IF;
   EXCEPTION WHEN duplicate_column THEN
     NULL;
   END $$;
