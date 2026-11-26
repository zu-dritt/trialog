-- Any participants. Idempotent; the app also runs this on first request.
-- Run it after the earlier files: it expects their tables to exist.
--
-- Until now the tables only accepted the first three participant names. Who may post is now the
-- PARTICIPANTS setting, checked by the application, and the database only checks that a stored
-- name has the shape of one: lowercase, starting with a letter, then letters, digits or "-",
-- at most 24 characters. That shape also fits `hub`, the author of the welcome message.
--
-- The earlier migration files are left exactly as they were, name lists included. This file
-- replaces every check that lists names (on messages, attachments, participant_status, polls and
-- poll_votes) with a check on the shape. No row is changed, and every existing row passes,
-- because the old names have that shape. On a database that is already up to date it only looks,
-- and alters nothing. The earlier application keeps working on a migrated database.
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
