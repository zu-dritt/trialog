// Message storage. Production uses Neon Postgres through `pg` on the pooled DATABASE_URL.
// The same SQL store is tested against PGlite. Without DATABASE_URL, `next dev` falls back to
// an in-memory store (lost on restart) so the page can be tried locally; production refuses.
//
// Image attachments: this file keeps their rows (who, size, which message). Their bytes are read
// and written only through lib/blobs.ts.
import { randomBytes } from 'node:crypto';
import { createMemoryBlobs, createSqlBlobs, type Blobs } from './blobs';
import { MAX_SCALE, validScale } from './shared';
import {
  MAIN_ROOM, MAX_ROOMS, ROOM_NAME_MAX_LENGTH, PIN_TITLE_MAX_LENGTH,
  MAX_ATTACHMENT_BYTES, NAME_PATTERN, ORPHAN_MAX_AGE_MS, RATE_LIMIT_PER_MIN, RECENTLY_CLOSED_MS, UPLOADS_PER_HOUR, WAKE_TEST_PER_MIN, welcomeText,
  pollResultText, decisionIsAgreed, decisionPositionText,
  type Attachment, type Author, type DecisionCard, type DecisionPosition, type DecisionStance, type ImageType, type Message, type ParticipantStatus, type Poll, type Reaction, type ReadPosition, type Room, type Sender,
} from './core';
import { decisionSqlPattern, isDecision } from './decision';
import { DEFAULT_PARTICIPANTS, loadRoster, parseParticipants } from './participants';
import { SEARCH_LIMIT, likePattern, matchesAll } from './search';

export type Row = Record<string, unknown>;
export interface Queryable {
  query(text: string, params: unknown[]): Promise<Row[]>;
}
/** The minimum the store needs from a database: queries, and a transaction on one connection. */
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface NewMessage {
  sender: Author;
  recipient: Sender | null;
  text: string;
  pinned?: boolean;
  /** Ids of the sender's own uploads that no message links yet, in the order they should appear. */
  attachments?: string[];
  /** The id of an existing message that this one answers. */
  reply_to?: number | null;
  /**
   * The room the message goes to. Left out or null: the room of the message it answers, and `main`
   * when it answers none. A reply can't go to another room than the message it answers.
   */
  room?: string | null;
}
/** An image that has already been checked and re-encoded (lib/images.ts). */
export interface NewAttachment {
  sender: Sender;
  content_type: ImageType;
  width: number;
  height: number;
  data: Buffer;
  /** Image pixels per point (Attachment.scale). Left out: 1. */
  scale?: number;
}
export interface StoredAttachment extends Attachment {
  sender: Sender;
  /** null until a message links it. */
  message_id: number | null;
}
/** Thrown by add() when an attachment can't be linked. Nothing is stored in that case. */
/** Thrown by add() when `reply_to` names a message that does not exist. Nothing is stored in that case. */
export class ReplyTargetError extends Error {
  constructor(readonly messageId: number) {
    super(`Message #${messageId} does not exist, so it can't be replied to.`);
    this.name = 'ReplyTargetError';
  }
}
/**
 * Thrown when a room can't be used or created: it does not exist, its id is taken, the hub has
 * all the rooms it can have, or a reply would go to another room than the message it answers.
 * Nothing is stored in that case.
 */
export class RoomError extends Error {
  constructor(readonly reason: 'not found' | 'exists' | 'full' | 'other room' | 'read elsewhere', readonly room: string, answered?: { id: number; room: string }) {
    super({
      'not found': `Room "${room}" does not exist. GET /api/rooms lists the rooms.`,
      exists: `A room with the id "${room}" already exists.`,
      full: `A hub has at most ${MAX_ROOMS} rooms.`,
      'other room': `Message #${answered?.id} is in the room "${answered?.room}", so a reply to it can't go to the room "${room}". Leave "room" out and the reply goes where that message is.`,
      'read elsewhere': `Message #${answered?.id} is in the room "${answered?.room}", not in "${room}". Leave "room" out and the position is recorded where that message is.`,
    }[reason]);
    this.name = 'RoomError';
  }
}
export class AttachmentLinkError extends Error {
  constructor(readonly attachmentId: string, readonly reason: 'unknown' | 'not yours' | 'already linked') {
    super({
      unknown: `Attachment ${attachmentId} does not exist (uploads that are not linked within an hour are deleted).`,
      'not yours': `Attachment ${attachmentId} was uploaded by someone else. You can only attach your own uploads.`,
      'already linked': `Attachment ${attachmentId} already belongs to a message.`,
    }[reason]);
    this.name = 'AttachmentLinkError';
  }
}
/** Thrown by poll vote, unvote and close when the action is not allowed. */
export class PollError extends Error {
  constructor(readonly reason: 'not found' | 'closed' | 'not the creator' | 'bad option') {
    super({
      'not found': 'Poll not found.',
      closed: 'This poll is closed.',
      'not the creator': 'Only the creator can close this poll.',
      'bad option': 'That option is not on this poll.',
    }[reason]);
    this.name = 'PollError';
  }
}
export class DecisionError extends Error {
  constructor(readonly reason: 'not found' | 'note required') {
    super({
      'not found': 'Decision card not found.',
      'note required': 'An Object needs a note that says why.',
    }[reason]);
    this.name = 'DecisionError';
  }
}
export class ReadError extends Error {
  constructor(readonly reason: 'not found') {
    super({
      'not found': 'That message does not exist.',
    }[reason]);
    this.name = 'ReadError';
  }
}
export interface NewPoll {
  creator: Sender;
  question: string;
  options: string[];
  recipient?: Sender | null;
  /** The room the poll goes to. Left out or null: `main`. */
  room?: string | null;
}
export interface NewDecision {
  creator: Sender;
  prompt: string;
  recipient?: Sender | null;
  reply_to?: number | null;
  /** The room the card goes to, by the same rule as NewMessage.room. */
  room?: string | null;
}
export interface NewRoom {
  id: string;
  name: string;
  created_by: Sender;
}
export interface ListOptions {
  since?: number | null;
  to?: Sender | null;
  limit?: number;
  /** Only this room. Left out or null: every room. (The API routes pass `main` when a caller names none.) */
  room?: string | null;
}
export interface RoomListOptions {
  /** The id of the newest message the caller has seen, per room. With it, every room gets `unread`. */
  seen?: Readonly<Record<string, number>> | null;
  /** The caller. Their own messages are not counted as unread. */
  me?: Sender | null;
}
export interface SearchOptions {
  /** A message matches when it contains every one of these, in upper or lower case. */
  words: string[];
  to?: Sender | null;
  /**
   * Only decisions: messages that start with DECISION:, by the rule in lib/decision.ts, pinned or
   * not. The value is the list of participants' names, which the rule needs (an "@name" may stand
   * in front of DECISION:). Left out or null: all messages.
   */
  decisionsAmong?: readonly string[] | null;
  /** Only pinned messages, decision or not. */
  pinned?: boolean;
  limit?: number;
  /** Only this room. Left out or null: every room. */
  room?: string | null;
}
/** A range of messages one wake-up webhook covers. `previous_id` is what the watermark was before the claim. */
export interface WakeupClaim {
  first_id: number;
  last_id: number;
  count: number;
  previous_id: number;
}
/** A participant's registered wake-up URL. The secret is never included. */
export interface WakeTargetInfo {
  url: string;
  updated_at: string;
}
export type WakeStatus = 'pending' | 'sending' | 'delivered' | 'failed';
/** A 'sending' claim that is older than this is treated as pending again. */
export const WAKE_SENDING_STALE_MS = 60_000;
/** Delivery of one wake-up, for one message and one participant. */
export interface WakeDelivery {
  message_id: number;
  participant: string;
  status: WakeStatus;
  attempts: number;
  error: string | null;
  updated_at: string;
}
/** A pending wake-up, with the message fields the signed payload needs. */
export interface PendingWake {
  message_id: number;
  participant: string;
  sender: Sender;
  recipient: Sender | null;
  text: string;
  /** The room the message is in. */
  room: string;
  /** True when this wake is (also) a request to write a short title for a pin that has none. */
  needs_pin_title: boolean;
}
/** What the live stream compares once a second to decide whether anything changed. */
export interface SetStatusInput {
  participant: Sender;
  text: string;
  ttlSeconds: number;
}
export interface StreamVersion {
  last_id: number;
  pins: string;
  /** Fingerprint of poll rows and votes, so the live stream can push tally changes. */
  polls: string;
  /** Fingerprint of who reacted with what; a new, changed or withdrawn reaction changes it. */
  reactions: string;
  /** Fingerprint of decision-card positions, so the live stream can push only what changed. */
  decisions: string;
  /** Fingerprint of read positions, so the live stream can push only the positions that moved. */
  reads: string;
  /** Every room with its newest message id, so the live stream can say when another room has news. */
  rooms: string;
}

/** Reactions on one message, as returned at the top level of GET /api/messages. */
export interface MessageReactions {
  message_id: number;
  reactions: Reaction[];
}

export type AddReactionResult =
  | { status: 'ok'; message: Message }
  | { status: 'not_found' }
  | { status: 'rate_limited' };
export interface Store {
  ensure(): Promise<void>;
  /**
   * Returns the stored message, or null when the sender is over the rate limit.
   * Throws AttachmentLinkError when one of `attachments` is unknown, someone else's or already linked,
   * ReplyTargetError when `reply_to` names a message that does not exist, and RoomError when the
   * room does not exist or is another one than the room of the message that is answered.
   */
  add(input: NewMessage, limitPerMin?: number): Promise<Message | null>;
  /**
   * Stores an upload that no message links yet. Returns null when the sender is over the hourly limit.
   * Every call first deletes uploads that have stayed unlinked for more than an hour.
   */
  addAttachment(input: NewAttachment, limitPerHour?: number): Promise<Attachment | null>;
  /**
   * How many images this sender has uploaded in the last hour. A quick look without a lock, so the
   * route can refuse a sender who is over the limit before it decodes anything. The count that
   * decides is still the locked one inside addAttachment.
   */
  uploadsInLastHour(sender: Sender): Promise<number>;
  /** The attachment and its bytes, or null. */
  getAttachment(id: string): Promise<{ attachment: StoredAttachment; data: Buffer } | null>;
  /** since=null → the latest `limit` messages; since=n → messages with id > n, oldest first. */
  list(options?: ListOptions): Promise<Message[]>;
  /**
   * The messages that contain every word, newest first. The words are taken literally. A poll's
   * question and options count as text of the message that carries the poll.
   */
  search(options: SearchOptions): Promise<Message[]>;
  /** The pinned messages of one room, or of every room when none is named. */
  pinned(room?: string | null): Promise<Message[]>;
  /** Pins or unpins a message. `title` is set when given; unpinning always clears it. Null when the id does not exist. */
  setPinned(id: number, pinned: boolean, title?: string): Promise<Message | null>;
  /**
   * Sets the title of a message that is already pinned. Null when the id does not exist;
   * `'not-pinned'` when the message is not pinned.
   */
  setPinTitle(id: number, title: string): Promise<Message | null | 'not-pinned'>;
  /** Every message of one room, or of every room when none is named. */
  all(room?: string | null): Promise<Message[]>;
  /**
   * A cheap fingerprint of the stream: the newest message id and the pinned ids (of one room, or
   * of every room when none is named), polls, reactions, decision cards, read positions and the rooms.
   */
  version(room?: string | null): Promise<StreamVersion>;
  /** Every room, `main` first, then in the order they were created. */
  listRooms(options?: RoomListOptions): Promise<Room[]>;
  /** One room, or null when there is none with that id. */
  getRoom(id: string): Promise<Room | null>;
  /** Creates a room. Throws RoomError when the id is taken or the hub has all the rooms it can have. */
  createRoom(input: NewRoom): Promise<Room>;
  /**
   * Claims every message Grok has not been woken for yet (addressed to Grok or to everyone, not
   * written by Grok or the hub) and moves the watermark past them. Returns null when there is
   * nothing new, which means another job already covered it. Kept so a database from before
   * per-agent deliveries still has a watermark; new deliveries use the methods below.
   */
  claimWakeup(): Promise<WakeupClaim | null>;
  /** After a failed delivery: puts the watermark back, unless a later claim has moved it on. */
  releaseWakeup(claim: WakeupClaim): Promise<boolean>;
  /** Registers or replaces this participant's wake-up URL and secret. The secret is stored, never returned. */
  setWakeTarget(participant: Sender, url: string, secret: string): Promise<WakeTargetInfo>;
  /** The registered URL, or null. Never includes the secret. */
  getWakeTarget(participant: Sender): Promise<WakeTargetInfo | null>;
  /** The URL and secret, for signing a request only. Null when none is registered. */
  getWakeCredentials(participant: Sender): Promise<{ url: string; secret: string } | null>;
  /** Drops this participant's target. Returns true when a row was there. */
  clearWakeTarget(participant: Sender): Promise<boolean>;
  /** Queues a pending delivery for each participant, skipping any row that already exists. */
  enqueueWakes(messageId: number, participants: readonly string[]): Promise<void>;
  /**
   * Queues a wake-up so an agent can write a title for a pin that has none. Re-opens a
   * delivered or failed row, and leaves a still-pending or in-flight one as it is (that
   * delivery already sees `needs_pin_title` from the message).
   */
  enqueueWakesForPinTitle(messageId: number, participants: readonly string[]): Promise<void>;
  /** Pending deliveries, oldest message first, with the text the payload needs. */
  listPendingWakes(): Promise<PendingWake[]>;
  /**
   * Atomically claims due wake-ups (pending, or sending older than a minute) and marks them
   * sending. Two callers never receive the same row. SKIP LOCKED, so concurrent jobs take
   * different rows rather than waiting.
   */
  claimPendingWakes(): Promise<PendingWake[]>;
  /** Registered targets, for a human to list who has one. Includes the URL for host extraction; never the secret. */
  listWakeTargets(): Promise<{ participant: Sender; url: string; updated_at: string }[]>;
  /**
   * Records one wake-test attempt and returns true when this participant is still under the
   * per-minute limit. False means the call must be refused with 429.
   */
  takeWakeTestSlot(participant: Sender, limitPerMin?: number): Promise<boolean>;
  /** Records the outcome of one delivery attempt. */
  saveWakeDelivery(messageId: number, participant: string, status: WakeStatus, attempts: number, error: string | null): Promise<WakeDelivery>;
  /** Delivery rows for these messages, in message-id then participant order. */
  listWakes(messageIds: readonly number[]): Promise<WakeDelivery[]>;
  /**
   * Messages with id > `since` that should wake `participant`, oldest first.
   * Those of one room, or of every room when none is named: the wake rule is the same in every room.
   * `humans` and `agents` are names from the roster. The participant must be one of the agents.
   */
  listWakingMessages(options: { participant: Sender; since: number | null; limit: number; humans: readonly string[]; agents: readonly string[]; room?: string | null }): Promise<Message[]>;
  /** Sets or replaces the caller's active working status with a TTL in seconds. */
  setStatus(input: SetStatusInput): Promise<ParticipantStatus>;
  /** Clears the caller's working status; returns true if a row existed. */
  clearStatus(participant: Sender): Promise<boolean>;
  /** Active (non-expired) statuses for all participants; lazily drops expired rows. */
  listStatuses(): Promise<ParticipantStatus[]>;
  /**
   * Creates a message and an attached poll in one transaction.
   * Returns null when the sender is over the message rate limit.
   */
  createPoll(input: NewPoll, limitPerMin?: number): Promise<{ message: Message; poll: Poll } | null>;
  getPoll(id: string): Promise<Poll | null>;
  /** Open polls, plus polls closed within the last 24 hours: those of one room, or of every room when none is named. */
  listPolls(room?: string | null): Promise<Poll[]>;
  /** Every message that has a poll, with the current tally, oldest first. */
  listPollMessages(): Promise<Message[]>;
  /** Messages with the given ids, in id order. Missing ids are skipped. */
  listMessagesByIds(ids: number[]): Promise<Message[]>;
  /** Records or changes the caller's vote. */
  vote(pollId: string, participant: Sender, option: number): Promise<Poll>;
  /** Withdraws the caller's vote. `withdrawn` is false when they had no vote. */
  unvote(pollId: string, participant: Sender): Promise<{ poll: Poll; withdrawn: boolean }>;
  /**
   * Closes the poll and, the first time, posts a result message from the closer (question, counts,
   * voter names) as a reply to the poll message. Only the creator may do this. Idempotent if already
   * closed (`message` is then null). Returns null when the sender is over the message rate limit;
   * the poll stays open so they can retry.
   */
  closePoll(pollId: string, participant: Sender, limitPerMin?: number): Promise<{ poll: Poll; message: Message | null } | null>;
  /**
   * Adds the caller's reaction. The participant comes from the token, never from a body.
   * Returns rate_limited when this sender has added 30 reactions in the last minute.
   * Putting the same emoji again is a no-op and is not counted against the limit.
   */
  addReaction(messageId: number, participant: Sender, emoji: string, limitPerMin?: number): Promise<AddReactionResult>;
  /** Removes the caller's reaction. Returns null when the message does not exist. */
  removeReaction(messageId: number, participant: Sender, emoji: string): Promise<Message | null>;
  /** Every message that currently has reactions, in one room or in every room when none is named. For since-poll. */
  listReactions(room?: string | null): Promise<MessageReactions[]>;
  /**
   * Creates a message and an attached decision card. The creator is the owner of the token.
   * Returns null when the sender is over the message rate limit.
   */
  createDecision(input: NewDecision, roster?: readonly string[], limitPerMin?: number): Promise<{ message: Message; decision: DecisionCard } | null>;
  /**
   * Records or changes the caller's Agree or Object. `roster` is the current participants:
   * when every one of them has agreed, the message is pinned and agreed_at is set.
   * Returns rate_limited when this sender has recorded 30 positions in the last minute (a no-op change is not counted).
   */
  recordDecisionPosition(cardId: string, participant: Sender, stance: DecisionStance, note: string | null, roster: readonly string[], limitPerMin?: number): Promise<{ status: 'ok'; decision: DecisionCard; message: Message; reply: Message | null } | { status: 'rate_limited' }>;
  /** Every decision card of one room, or of every room when none is named. For since-poll. */
  listDecisions(room?: string | null): Promise<DecisionCard[]>;
  /**
   * Moves this participant's read position in the room of message `upTo` to that message, if it
   * is a higher id than they already have there. A lower id is ignored. A participant has one
   * position per room: reading one room says nothing about another. Throws ReadError when the
   * message does not exist, and RoomError when `room` is given and the message is in another room.
   */
  setReadPosition(participant: Sender, upTo: number, room?: string | null): Promise<ReadPosition>;
  /** The read positions of one room, or of every room when none is named. For the opt-in list and the stream. */
  listReads(room?: string | null): Promise<ReadPosition[]>;
}

// Two instances that start at the same moment take turns at the one statement that may alter tables.
const MIGRATION_LOCK_ID = 7230420;

// Who may post is decided by the PARTICIPANTS setting, in the application (lib/participants.ts).
// The database only checks that a stored name has the shape of one, which also fits `hub`, the
// author of the welcome message. So adding or removing a participant never needs a schema change,
// and the messages of someone who is no longer a participant stay where they are.
//
// The statements below that have a file in migrations/ are kept word for word as those files
// have them, so the older ones still list the first three names. The last statement
// (migrations/007-any-participants.sql) replaces those lists with the checks on the shape, on a
// new database as on an old one.
const NAME_SHAPE = `'${NAME_PATTERN.source}'`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id         BIGSERIAL PRIMARY KEY,
     sender     TEXT NOT NULL CONSTRAINT messages_sender_shape CHECK (sender ~ ${NAME_SHAPE}),
     recipient  TEXT CONSTRAINT messages_recipient_shape CHECK (recipient ~ ${NAME_SHAPE}),
     text       TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     pinned_at  TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS messages_sender_created_at ON messages (sender, created_at)`,
  // At most one welcome message, even if two instances start at once.
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_one_welcome ON messages (sender) WHERE sender = 'hub'`,
  // v2 PR 2 (migrations/001-webhook-state.sql): one row holding the last message id Grok was woken for.
  `CREATE TABLE IF NOT EXISTS webhook_state (
     id               INT PRIMARY KEY CHECK (id = 1),
     last_notified_id BIGINT NOT NULL DEFAULT 0
   )`,
  // Starts at the newest message, so history from before the webhook existed never triggers a wake-up.
  `INSERT INTO webhook_state (id, last_notified_id)
   SELECT 1, coalesce(max(id), 0) FROM messages
   ON CONFLICT (id) DO NOTHING`,
  // Image attachments (migrations/002-attachments.sql). A row is created by an upload and linked to
  // a message later. `data` holds the re-encoded image; only lib/blobs.ts reads or writes it.
  `CREATE TABLE IF NOT EXISTS attachments (
     id           TEXT PRIMARY KEY CHECK (id ~ '^att_[a-z0-9]+$'),
     sender       TEXT NOT NULL CHECK (sender IN ('grok', 'claude', 'david')),
     message_id   BIGINT REFERENCES messages (id) ON DELETE CASCADE,
     position     SMALLINT NOT NULL DEFAULT 0,
     content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
     bytes        INT NOT NULL CHECK (bytes > 0 AND bytes <= ${MAX_ATTACHMENT_BYTES}),
     width        INT NOT NULL CHECK (width > 0),
     height       INT NOT NULL CHECK (height > 0),
     data         BYTEA CHECK (data IS NULL OR octet_length(data) = bytes),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS attachments_message_id ON attachments (message_id)`,
  `CREATE INDEX IF NOT EXISTS attachments_sender_created_at ON attachments (sender, created_at)`,
  // Participant working status (migrations/003-status.sql).
  `CREATE TABLE IF NOT EXISTS participant_status (
     participant TEXT PRIMARY KEY CHECK (participant IN ('grok', 'claude', 'david')),
     text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
     expires_at  TIMESTAMPTZ NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS participant_status_expires_at ON participant_status (expires_at)`,
  // Polls and votes (migrations/004-polls.sql).
  // polls_creator_is_participant and poll_votes_participant_is_participant list the first three
  // names. Migration 007 below drops them and checks the shape of the name instead.
  `CREATE TABLE IF NOT EXISTS polls (
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
)`,
  `CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id      TEXT NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  participant  TEXT NOT NULL,
  option_index SMALLINT NOT NULL CHECK (option_index >= 1 AND option_index <= 10),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, participant),
  CONSTRAINT poll_votes_participant_is_participant CHECK (participant IN ('grok', 'claude', 'david'))
)`,
  // Replies (migrations/005-replies.sql): a message can name the earlier message it answers.
  // The column is only added when it is missing. A plain ADD COLUMN IF NOT EXISTS would ask for
  // an exclusive lock on the table on every cold start, even with nothing to do.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'reply_to'
     ) THEN
       ALTER TABLE messages ADD COLUMN reply_to BIGINT REFERENCES messages (id) ON DELETE SET NULL;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL`,
  // The scale of an image (migrations/006-attachment-scale.sql): how many of its pixels make one
  // point on the screen it was taken on. Images stored before this have 1. The column is only
  // added when it is missing; a plain ADD COLUMN IF NOT EXISTS would ask for an exclusive lock on
  // the table every time, even with nothing to do.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'attachments' AND column_name = 'scale'
     ) THEN
       ALTER TABLE attachments ADD COLUMN scale SMALLINT NOT NULL DEFAULT 1
         CONSTRAINT attachments_scale_range CHECK (scale BETWEEN 1 AND ${MAX_SCALE});
     END IF;
   EXCEPTION WHEN duplicate_column THEN
     NULL;
   END $$`,
  // Any participants (migrations/007-any-participants.sql). The tables above were created with
  // checks that list the first three names. This replaces every one of them with a check on the
  // shape of a name. No row is changed, and every existing row passes, because the old names have
  // that shape. On a database that is already up to date it only looks, and alters nothing.
  `DO $$
   DECLARE old record;
   BEGIN
     PERFORM pg_advisory_xact_lock(${MIGRATION_LOCK_ID});
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
       ALTER TABLE messages ADD CONSTRAINT messages_sender_shape CHECK (sender ~ ${NAME_SHAPE});
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_recipient_shape') THEN
       ALTER TABLE messages ADD CONSTRAINT messages_recipient_shape CHECK (recipient ~ ${NAME_SHAPE});
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'attachments'::regclass AND conname = 'attachments_sender_shape') THEN
       ALTER TABLE attachments ADD CONSTRAINT attachments_sender_shape CHECK (sender ~ ${NAME_SHAPE});
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'participant_status'::regclass AND conname = 'participant_status_participant_shape') THEN
       ALTER TABLE participant_status ADD CONSTRAINT participant_status_participant_shape CHECK (participant ~ ${NAME_SHAPE});
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'polls'::regclass AND conname = 'polls_creator_shape') THEN
       ALTER TABLE polls ADD CONSTRAINT polls_creator_shape CHECK (creator ~ ${NAME_SHAPE});
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'poll_votes'::regclass AND conname = 'poll_votes_participant_shape') THEN
       ALTER TABLE poll_votes ADD CONSTRAINT poll_votes_participant_shape CHECK (participant ~ ${NAME_SHAPE});
     END IF;
   END $$`,
  // Message reactions (migrations/008-reactions.sql).
  `CREATE TABLE IF NOT EXISTS reactions (
     message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     participant TEXT NOT NULL,
     emoji       TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (message_id, participant, emoji),
     CONSTRAINT reactions_participant_shape CHECK (participant ~ ${NAME_SHAPE})
   )`,
  // If an earlier draft of this table listed names, replace that check with the shape check.
  `DO $$
   BEGIN
     PERFORM pg_advisory_xact_lock(7230421);
     ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_participant_is_participant;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'reactions'::regclass AND conname = 'reactions_participant_shape') THEN
       ALTER TABLE reactions ADD CONSTRAINT reactions_participant_shape CHECK (participant ~ ${NAME_SHAPE});
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS reactions_message_id ON reactions (message_id)`,
  // Decision cards (migrations/009-decision-cards.sql).
  `CREATE TABLE IF NOT EXISTS decision_cards (
     id          TEXT PRIMARY KEY,
     message_id  BIGINT NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
     creator     TEXT NOT NULL,
     prompt      TEXT NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     agreed_at   TIMESTAMPTZ,
     CONSTRAINT decision_cards_creator_shape CHECK (creator ~ ${NAME_SHAPE}),
     CONSTRAINT decision_cards_id_shape CHECK (id ~ '^decision_[a-z0-9]{8,48}$')
   )`,
  `CREATE TABLE IF NOT EXISTS decision_positions (
     card_id     TEXT NOT NULL REFERENCES decision_cards (id) ON DELETE CASCADE,
     participant TEXT NOT NULL,
     stance      TEXT NOT NULL CHECK (stance IN ('agree', 'object')),
     note        TEXT,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (card_id, participant),
     CONSTRAINT decision_positions_participant_shape CHECK (participant ~ ${NAME_SHAPE}),
     CONSTRAINT decision_positions_object_has_note CHECK (stance = 'agree' OR (note IS NOT NULL AND char_length(btrim(note)) > 0))
   )`,
  `CREATE INDEX IF NOT EXISTS decision_cards_message_id ON decision_cards (message_id)`,
  // Read positions (migrations/010-read-markers.sql).
  `CREATE TABLE IF NOT EXISTS read_positions (
     participant TEXT NOT NULL,
     up_to       BIGINT NOT NULL REFERENCES messages (id),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (participant),
     CONSTRAINT read_positions_participant_shape CHECK (participant ~ ${NAME_SHAPE}),
     CONSTRAINT read_positions_up_to_positive CHECK (up_to > 0)
   )`,
  `CREATE INDEX IF NOT EXISTS read_positions_up_to ON read_positions (up_to)`,
  // Wake-up targets and delivery status (migrations/011-wake-targets.sql).
  `CREATE TABLE IF NOT EXISTS wake_targets (
     participant TEXT PRIMARY KEY,
     url         TEXT NOT NULL,
     secret      TEXT NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT wake_targets_participant_shape CHECK (participant ~ ${NAME_SHAPE}),
     CONSTRAINT wake_targets_url_https CHECK (url ~ '^https://' AND char_length(url) BETWEEN 8 AND 2048),
     CONSTRAINT wake_targets_secret_length CHECK (char_length(secret) BETWEEN 16 AND 256)
   )`,
  `CREATE TABLE IF NOT EXISTS wake_deliveries (
     message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     participant TEXT NOT NULL,
     status      TEXT NOT NULL,
     attempts    INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     error       TEXT,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (message_id, participant),
     CONSTRAINT wake_deliveries_participant_shape CHECK (participant ~ ${NAME_SHAPE}),
     CONSTRAINT wake_deliveries_status_check CHECK (status IN ('pending', 'sending', 'delivered', 'failed'))
   )`,
  `CREATE INDEX IF NOT EXISTS wake_deliveries_participant_message ON wake_deliveries (participant, message_id)`,
  `CREATE INDEX IF NOT EXISTS wake_deliveries_pending ON wake_deliveries (message_id) WHERE status IN ('pending', 'sending')`,
  `CREATE TABLE IF NOT EXISTS wake_test_events (
     participant TEXT NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT wake_test_events_participant_shape CHECK (participant ~ ${NAME_SHAPE})
   )`,
  `CREATE INDEX IF NOT EXISTS wake_test_events_participant_created ON wake_test_events (participant, created_at)`,
  // Rooms (migrations/012-rooms.sql): more than one stream in one hub. The room `main` always
  // exists, and every message from before rooms is in it. Message ids stay global across rooms.
  `CREATE TABLE IF NOT EXISTS rooms (
     id         TEXT PRIMARY KEY CONSTRAINT rooms_id_shape CHECK (id ~ ${NAME_SHAPE}),
     name       TEXT NOT NULL CONSTRAINT rooms_name_length CHECK (char_length(name) BETWEEN 1 AND ${ROOM_NAME_MAX_LENGTH}),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     created_by TEXT NOT NULL CONSTRAINT rooms_created_by_shape CHECK (created_by ~ ${NAME_SHAPE})
   )`,
  `INSERT INTO rooms (id, name, created_by) VALUES ('${MAIN_ROOM}', 'Main', 'hub') ON CONFLICT (id) DO NOTHING`,
  // The column is only added when it is missing, like the ones above. Its default puts every
  // existing message into main without rewriting a row.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'room'
     ) THEN
       ALTER TABLE messages ADD COLUMN room TEXT NOT NULL DEFAULT '${MAIN_ROOM}'
         CONSTRAINT messages_room_exists REFERENCES rooms (id);
     END IF;
   EXCEPTION WHEN duplicate_column THEN
     NULL;
   END $$`,
  `CREATE INDEX IF NOT EXISTS messages_room_id ON messages (room, id)`,
  // A read position is per participant and room: reading one room says nothing about another.
  // The positions from before rooms belong to main, where every message of that time is.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'read_positions' AND column_name = 'room'
     ) THEN
       ALTER TABLE read_positions ADD COLUMN room TEXT NOT NULL DEFAULT '${MAIN_ROOM}'
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
   END $$`,
  // Pin titles (migrations/013-pin-titles.sql): a short title stored with a pinned message.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'pin_title'
     ) THEN
       ALTER TABLE messages ADD COLUMN pin_title TEXT
         CONSTRAINT messages_pin_title_length CHECK (pin_title IS NULL OR (char_length(pin_title) BETWEEN 1 AND ${PIN_TITLE_MAX_LENGTH}));
     END IF;
   EXCEPTION WHEN duplicate_column THEN
     NULL;
   END $$`,
];
export const SCHEMA_SQL = SCHEMA.join(';\n\n') + ';\n';

const BASE_COLS = 'id, sender, recipient, text, created_at, pinned_at, pin_title, reply_to, room';
const ATTACHMENT_COLS = 'id, content_type, width, height, bytes, scale';
// Every message comes back with its attachments (never their bytes), in the order the sender gave.
const POLL_JSON = `json_build_object(
  'id', p.id,
  'message_id', p.message_id,
  'creator', p.creator,
  'question', p.question,
  'closed_at', p.closed_at,
  'created_at', p.created_at,
  'options', (
    SELECT coalesce(json_agg(json_build_object(
      'index', i,
      'text', p.options[i],
      'votes', (SELECT count(*)::int FROM poll_votes v WHERE v.poll_id = p.id AND v.option_index = i),
      'voters', (SELECT coalesce(json_agg(v.participant ORDER BY v.updated_at, v.participant), '[]'::json)
                 FROM poll_votes v WHERE v.poll_id = p.id AND v.option_index = i)
    ) ORDER BY i), '[]'::json)
    FROM generate_subscripts(p.options, 1) AS i
  )
)`;
const DECISION_JSON = `json_build_object(
  'id', c.id,
  'message_id', c.message_id,
  'creator', c.creator,
  'prompt', c.prompt,
  'created_at', c.created_at,
  'agreed_at', c.agreed_at,
  'positions', (
    SELECT coalesce(json_agg(json_build_object(
      'participant', p.participant,
      'stance', p.stance,
      'note', p.note,
      'updated_at', p.updated_at
    ) ORDER BY p.updated_at, p.participant), '[]'::json)
    FROM decision_positions p WHERE p.card_id = c.id
  )
)`;
const COLS = `${BASE_COLS},
  (SELECT coalesce(json_agg(json_build_object('id', a.id, 'content_type', a.content_type,
            'width', a.width, 'height', a.height, 'bytes', a.bytes, 'scale', a.scale) ORDER BY a.position, a.id), '[]'::json)
     FROM attachments a WHERE a.message_id = messages.id) AS attachments,
  (SELECT ${POLL_JSON} FROM polls p WHERE p.message_id = messages.id) AS poll,
  (SELECT ${DECISION_JSON} FROM decision_cards c WHERE c.message_id = messages.id) AS decision,
  (SELECT coalesce(json_agg(json_build_object('emoji', g.emoji, 'by', g.by) ORDER BY g.first_at, g.emoji), '[]'::json)
     FROM (
       SELECT emoji,
              json_agg(participant ORDER BY created_at, participant) AS by,
              min(created_at) AS first_at
         FROM reactions
        WHERE message_id = messages.id
        GROUP BY emoji
     ) g) AS reactions`;
// Inserts take a transaction-level advisory lock so ids are committed in order: a poller asking
// for "since=<id>" can never skip a message that committed late with a lower id. Transaction-level
// locks work behind Neon's pooler (PgBouncer in transaction mode).
const LOCK_ID = 7230418;
// Uploads take their own lock, so a slow upload never holds up posting. It makes the hourly count
// exact when one sender uploads several images at once.
const UPLOAD_LOCK_ID = 7230419;
const REACTION_LOCK_ID = 7230420;
const WAKE_TEST_LOCK_ID = 7230422;
// Creating a room takes its own lock, so two requests at once can't both take the last free place.
const ROOM_LOCK_ID = 7230423;
// One row per room: its newest message id, and for a caller who says what they have seen ($1, a
// JSON object of room id → message id) how many messages by others ($2 is the caller) are newer.
const ROOMS_SQL = `SELECT r.id, r.name, r.created_at, r.created_by,
         coalesce((SELECT max(m.id) FROM messages m WHERE m.room = r.id), 0) AS last_id,
         CASE WHEN $1::jsonb IS NULL THEN NULL ELSE (
           SELECT count(*)::int FROM messages m
           WHERE m.room = r.id AND m.id > coalesce(($1::jsonb ->> r.id)::bigint, 0)
             AND ($2::text IS NULL OR m.sender <> $2::text)
         ) END AS unread
    FROM rooms r
   WHERE ($3::text IS NULL OR r.id = $3::text)
   ORDER BY (r.id <> '${MAIN_ROOM}'), r.created_at, r.id`;
const ROOMS_FINGERPRINT_SQL = `(SELECT coalesce(string_agg(r.id || ':' || coalesce((SELECT max(m.id) FROM messages m WHERE m.room = r.id), 0)::text, ',' ORDER BY r.id), '') FROM rooms r)`;
const ORPHAN_SECONDS = ORPHAN_MAX_AGE_MS / 1000;
const newAttachmentId = (): string => `att_${randomBytes(12).toString('hex')}`;
const newPollId = (): string => `poll_${randomBytes(12).toString('hex')}`;
const newDecisionId = (): string => `decision_${randomBytes(12).toString('hex')}`;
// One entry per poll: messageId:voteCount:latest, so the stream can re-send only what changed.
// `latest` is the newest of the last vote, the close time and the poll's created_at (so a vote
// change at a constant count still shows). Empty: `0|`.
const POLLS_FINGERPRINT_SQL = `(SELECT count(*)::text FROM polls) || '|' ||
  coalesce((
    SELECT string_agg(message_id::text || ':' || n::text || ':' || latest, ',' ORDER BY message_id)
    FROM (
      SELECT p.message_id,
             (SELECT count(*)::int FROM poll_votes v WHERE v.poll_id = p.id) AS n,
             greatest(
               coalesce((SELECT max(updated_at) FROM poll_votes v WHERE v.poll_id = p.id), '-infinity'::timestamptz),
               coalesce(p.closed_at, '-infinity'::timestamptz),
               p.created_at
             )::text AS latest
      FROM polls p
    ) t
  ), '')`;
// One entry per message: id:count:latest, so a swap (same count, different emoji) still shows.
const REACTIONS_FINGERPRINT_SQL = `(SELECT count(*)::text FROM reactions) || '|' ||
  (SELECT coalesce(max(created_at)::text, '') FROM reactions) || '|' ||
  (SELECT coalesce(string_agg(message_id::text || ':' || n::text || ':' || latest, ',' ORDER BY message_id), '')
     FROM (
       SELECT message_id, count(*)::int AS n, max(created_at)::text AS latest
       FROM reactions
       GROUP BY message_id
     ) t)`;
const DECISIONS_FINGERPRINT_SQL = `(SELECT count(*)::text FROM decision_cards) || '|' ||
  coalesce((
    SELECT string_agg(message_id::text || ':' || agree_n::text || ':' || object_n::text || ':' || latest, ',' ORDER BY message_id)
    FROM (
      SELECT c.message_id,
             (SELECT count(*)::int FROM decision_positions p WHERE p.card_id = c.id AND p.stance = 'agree') AS agree_n,
             (SELECT count(*)::int FROM decision_positions p WHERE p.card_id = c.id AND p.stance = 'object') AS object_n,
             greatest(
               coalesce((SELECT max(updated_at) FROM decision_positions p WHERE p.card_id = c.id), '-infinity'::timestamptz),
               coalesce(c.agreed_at, '-infinity'::timestamptz),
               c.created_at
             )::text AS latest
      FROM decision_cards c
    ) t
  ), '')`;

// The read positions of one room ($1), or of every room when $1 is null.
const READS_FINGERPRINT_SQL = `(SELECT count(*)::text FROM read_positions WHERE ($1::text IS NULL OR room = $1::text)) || '|' ||
  coalesce((SELECT string_agg(participant || ':' || up_to::text, ',' ORDER BY participant, room) FROM read_positions
             WHERE ($1::text IS NULL OR room = $1::text)), '')`;
// What hangs on a message (a poll, reactions, a decision card) is in that message's room. This
// keeps a list of such things to one room ($1), or to every room when $1 is null.
const inRoomSql = (messageId: string): string =>
  `($1::text IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.id = ${messageId} AND m.room = $1::text))`;
const toRead = (r: Row): ReadPosition => ({
  participant: String(r.participant) as Sender,
  room: String(r.room ?? MAIN_ROOM),
  up_to: Number(r.up_to),
  updated_at: new Date(r.updated_at as string | Date).toISOString(),
});

// Messages that wake Grok: addressed to Grok or to everyone, and not written by Grok or the hub.
const WAKES_GROK = `sender NOT IN ('grok', 'hub') AND (recipient IS NULL OR recipient = 'grok')`;
export const wakesGrok = (m: Pick<Message, 'sender' | 'recipient'>): boolean =>
  m.sender !== 'grok' && m.sender !== 'hub' && (m.recipient === null || m.recipient === 'grok');

/**
 * A message addressed to its own sender is stored as a message to everyone. "To myself" says
 * nothing, and it comes about by accident: a message that happens to begin with the writer's own
 * "@name", for example a pasted line. Stored as written, such a message would be addressed to
 * nobody else, so nobody would be woken for it.
 */
export const notToSelf = (sender: Author, recipient: Sender | null | undefined): Sender | null =>
  (recipient == null || recipient === sender ? null : recipient);

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const toAttachment = (r: Row): Attachment => ({
  id: r.id as string,
  content_type: r.content_type as ImageType,
  width: Number(r.width),
  height: Number(r.height),
  bytes: Number(r.bytes),
  scale: validScale(Number(r.scale)),
});
/** The json column arrives parsed from pg and PGlite; a string is handled in case a driver doesn't. */
const toAttachments = (v: unknown): Attachment[] => {
  const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(list) ? (list as Row[]).map(toAttachment) : [];
};
const toWakeDelivery = (r: Row): WakeDelivery => ({
  message_id: Number(r.message_id),
  participant: String(r.participant),
  status: r.status as WakeStatus,
  attempts: Number(r.attempts),
  error: r.error == null ? null : String(r.error),
  updated_at: iso(r.updated_at)!,
});

const toStatus = (r: Row): ParticipantStatus => ({
  participant: r.participant as Sender,
  text: r.text as string,
  expires_at: iso(r.expires_at) as string,
  updated_at: iso(r.updated_at) as string,
});
const toPoll = (v: unknown): Poll | null => {
  const raw = typeof v === 'string' ? JSON.parse(v) as unknown : v;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Row;
  if (r.id == null) return null;
  const optionsRaw = typeof r.options === 'string' ? JSON.parse(r.options as string) as unknown : r.options;
  const options = Array.isArray(optionsRaw) ? optionsRaw.map((item) => {
    const o = item as Row;
    const votersRaw = o.voters;
    const voters = Array.isArray(votersRaw)
      ? votersRaw.filter((name): name is Sender => typeof name === 'string')
      : [];
    return { index: Number(o.index), text: String(o.text), votes: Number(o.votes), voters };
  }) : [];
  return {
    id: String(r.id),
    message_id: Number(r.message_id),
    creator: r.creator as Sender,
    question: String(r.question),
    options,
    closed_at: iso(r.closed_at),
    created_at: iso(r.created_at) as string,
  };
};
const toReaction = (r: Row): Reaction => ({
  emoji: r.emoji as string,
  by: Array.isArray(r.by) ? (r.by as Sender[]) : (typeof r.by === 'string' ? (JSON.parse(r.by) as Sender[]) : []),
});
const toReactions = (v: unknown): Reaction[] => {
  const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(list) ? (list as Row[]).map(toReaction) : [];
};
const toMessageReactions = (r: Row): MessageReactions => ({
  message_id: Number(r.message_id),
  reactions: toReactions(r.reactions),
});

const toDecision = (v: unknown): DecisionCard | null => {
  const raw = typeof v === 'string' ? JSON.parse(v) as unknown : v;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Row;
  if (r.id == null) return null;
  const positionsRaw = typeof r.positions === 'string' ? JSON.parse(r.positions as string) as unknown : r.positions;
  const positions: DecisionPosition[] = Array.isArray(positionsRaw) ? positionsRaw.map((item) => {
    const o = item as Row;
    return {
      participant: o.participant as Sender,
      stance: o.stance as DecisionStance,
      note: o.note == null || o.note === '' ? null : String(o.note),
      updated_at: iso(o.updated_at) as string,
    };
  }) : [];
  return {
    id: String(r.id),
    message_id: Number(r.message_id),
    creator: r.creator as Sender,
    prompt: String(r.prompt),
    created_at: iso(r.created_at) as string,
    agreed_at: iso(r.agreed_at),
    positions,
  };
};

const toRoom = (r: Row): Room => ({
  id: r.id as string,
  name: r.name as string,
  created_at: iso(r.created_at) as string,
  created_by: r.created_by as Author,
  last_id: Number(r.last_id ?? 0),
  ...(r.unread == null ? {} : { unread: Number(r.unread) }),
});

const toPendingWake = (r: Row): PendingWake => ({
  message_id: Number(r.message_id),
  participant: String(r.participant),
  sender: r.sender as Sender,
  recipient: (r.recipient as Sender | null) ?? null,
  text: String(r.text),
  room: String(r.room ?? MAIN_ROOM),
  needs_pin_title: r.pinned_at != null && (r.pin_title == null || r.pin_title === ''),
});

const toMessage = (r: Row): Message => ({
  id: Number(r.id),
  sender: r.sender as Author,
  recipient: (r.recipient as Sender | null) ?? null,
  text: r.text as string,
  created_at: iso(r.created_at) as string,
  pinned_at: iso(r.pinned_at),
  pin_title: (r.pin_title as string | null | undefined) ?? null,
  room: (r.room as string | null | undefined) ?? MAIN_ROOM,
  attachments: toAttachments(r.attachments),
  reply_to: r.reply_to == null ? null : Number(r.reply_to),
  poll: toPoll(r.poll),
  decision: toDecision(r.decision),
  reactions: toReactions(r.reactions),
});

export interface StoreOptions {
  /** The message an empty hub starts with. It names the participants, so getStore() builds it from the setting. */
  welcome?: string;
}
const defaultWelcome = (): string => welcomeText(parseParticipants(DEFAULT_PARTICIPANTS));

/** SQL store on top of a Db (pg in production, PGlite in tests). */
export function createSqlStore(db: Db, blobs: Blobs = createSqlBlobs(), { welcome = defaultWelcome() }: StoreOptions = {}): Store {
  let ready: Promise<void> | null = null;
  async function init() {
    for (const stmt of SCHEMA) await db.query(stmt, []);
    await db.query(
      `INSERT INTO messages (sender, text)
       SELECT 'hub', $1::text WHERE NOT EXISTS (SELECT 1 FROM messages)
       ON CONFLICT (sender) WHERE sender = 'hub' DO NOTHING`,
      [welcome],
    );
  }
  function ensure(): Promise<void> {
    if (!ready) {
      // Retry once: two cold starts can race on CREATE TABLE IF NOT EXISTS.
      ready = init().catch(() => init()).catch((e: unknown) => { ready = null; throw e; });
    }
    return ready;
  }
  /**
   * The room a new message goes to: the one asked for; without one, the room of the message it
   * answers, and `main` when it answers none. Throws when the answered message or the room does
   * not exist, or when the two are different rooms.
   */
  async function roomFor(tx: Queryable, room: string | null, replyTo: number | null): Promise<string> {
    let answered: string | null = null;
    if (replyTo !== null) {
      // A reply must answer a message that exists. The foreign key would refuse it too; asking
      // first gives the sender a clear answer instead of a database error.
      const [parent] = await tx.query(`SELECT room FROM messages WHERE id = $1::bigint`, [replyTo]);
      if (!parent) throw new ReplyTargetError(replyTo);
      answered = parent.room as string;
    }
    if (room === null) return answered ?? MAIN_ROOM;
    if (answered !== null && answered !== room) throw new RoomError('other room', room, { id: replyTo as number, room: answered });
    if (room !== MAIN_ROOM && !(await tx.query(`SELECT 1 FROM rooms WHERE id = $1::text`, [room])).length) throw new RoomError('not found', room);
    return room;
  }

  return {
    ensure,
    async add({ sender, recipient, text, pinned, attachments = [], reply_to = null, room = null }, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      recipient = notToSelf(sender, recipient);
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        // Counted after taking the lock, so concurrent posts by one sender can't both slip past the limit.
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [sender],
        );
        if ((n as number) >= limitPerMin) return null;
        const inRoom = await roomFor(tx, room, reply_to);
        // Checked before the insert, and locked, so two posts can't link the same upload. A failure
        // here throws, which rolls the transaction back: no message, no link.
        const linked: Attachment[] = [];
        if (attachments.length) {
          const found = await tx.query(
            `SELECT ${ATTACHMENT_COLS}, sender, message_id FROM attachments WHERE id = ANY($1::text[]) FOR UPDATE`,
            [attachments],
          );
          for (const id of attachments) {
            const row = found.find((r) => r.id === id);
            if (!row) throw new AttachmentLinkError(id, 'unknown');
            if (row.sender !== sender) throw new AttachmentLinkError(id, 'not yours');
            if (row.message_id !== null) throw new AttachmentLinkError(id, 'already linked');
            linked.push(toAttachment(row));
          }
        }
        const rows = await tx.query(
          `INSERT INTO messages (sender, recipient, text, pinned_at, reply_to, room)
           VALUES ($1::text, $2::text, $3::text, CASE WHEN $4::boolean THEN now() END, $5::bigint, $6::text)
           RETURNING ${BASE_COLS}`,
          [sender, recipient, text, Boolean(pinned), reply_to, inRoom],
        );
        // The link commits together with the message, so a reader never sees one without the other.
        for (const [position, a] of linked.entries()) {
          await tx.query(
            `UPDATE attachments SET message_id = $1::bigint, position = $2::int WHERE id = $3::text`,
            [rows[0].id, position, a.id],
          );
        }
        return { ...toMessage(rows[0]), attachments: linked };
      });
    },
    async addAttachment({ sender, content_type, width, height, data, scale = 1 }, limitPerHour = UPLOADS_PER_HOUR) {
      await ensure();
      const id = newAttachmentId();
      let removed: string[] = [];
      const stored = await db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${UPLOAD_LOCK_ID})`, []);
        // Clean-up: uploads nobody linked within the hour. Linked attachments are never touched.
        const gone = await tx.query(
          `DELETE FROM attachments
           WHERE message_id IS NULL AND created_at < now() - $1::int * interval '1 second' RETURNING id`,
          [ORPHAN_SECONDS],
        );
        removed = gone.map((r) => r.id as string);
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM attachments WHERE sender = $1::text AND created_at > now() - interval '1 hour'`,
          [sender],
        );
        if ((n as number) >= limitPerHour) return null;
        await tx.query(
          `INSERT INTO attachments (id, sender, content_type, bytes, width, height, scale)
           VALUES ($1::text, $2::text, $3::text, $4::int, $5::int, $6::int, $7::int)`,
          [id, sender, content_type, data.length, width, height, scale],
        );
        await blobs.put(tx, id, data);
        return { id, content_type, width, height, bytes: data.length, scale };
      });
      if (removed.length) await blobs.delete(db, removed);
      return stored;
    },
    async uploadsInLastHour(sender) {
      await ensure();
      const [{ n }] = await db.query(
        `SELECT count(*)::int AS n FROM attachments WHERE sender = $1::text AND created_at > now() - interval '1 hour'`,
        [sender],
      );
      return n as number;
    },
    async getAttachment(id) {
      await ensure();
      const [row] = await db.query(`SELECT ${ATTACHMENT_COLS}, sender, message_id FROM attachments WHERE id = $1::text`, [id]);
      if (!row) return null;
      const data = await blobs.get(db, id);
      if (!data) return null;
      const attachment = { ...toAttachment(row), sender: row.sender as Sender, message_id: row.message_id === null ? null : Number(row.message_id) };
      return { attachment, data };
    },
    async list({ since = null, to = null, limit = 200, room = null } = {}) {
      await ensure();
      const rows = since === null
        ? await db.query(
          `SELECT * FROM (SELECT ${COLS} FROM messages
             WHERE ($1::text IS NULL OR recipient = $1::text) AND ($3::text IS NULL OR room = $3::text)
             ORDER BY id DESC LIMIT $2::int) t ORDER BY id`,
          [to, limit, room],
        )
        : await db.query(
          `SELECT ${COLS} FROM messages
           WHERE id > $1::bigint AND ($2::text IS NULL OR recipient = $2::text) AND ($4::text IS NULL OR room = $4::text)
           ORDER BY id LIMIT $3::int`,
          [since, to, limit, room],
        );
      return rows.map(toMessage);
    },
    async search({ words, to = null, decisionsAmong = null, pinned = false, limit = SEARCH_LIMIT, room = null }) {
      await ensure();
      if (!words.length) return [];
      // Plain ILIKE over the text, and over the poll's question and options when there is one.
      // Every word is a parameter with its LIKE characters escaped (the default escape is "\"),
      // so nothing in a query acts as a pattern. No index: at a few thousand short messages a
      // scan takes a few milliseconds.
      const rows = await db.query(
        `SELECT ${COLS} FROM messages
         WHERE (messages.text || E'\\n' || coalesce(
                 (SELECT p.question || E'\\n' || array_to_string(p.options, E'\\n') FROM polls p WHERE p.message_id = messages.id), ''))
               ILIKE ALL ($1::text[])
           AND ($2::text IS NULL OR recipient = $2::text)
           AND (NOT $3::boolean OR pinned_at IS NOT NULL)
           AND ($4::text IS NULL OR messages.text ~ $4::text
                OR EXISTS (SELECT 1 FROM decision_cards c WHERE c.message_id = messages.id AND c.agreed_at IS NOT NULL))
           AND ($6::text IS NULL OR room = $6::text)
         ORDER BY id DESC LIMIT $5::int`,
        [words.map(likePattern), to, pinned, decisionsAmong ? decisionSqlPattern(decisionsAmong) : null, limit, room],
      );
      return rows.map(toMessage);
    },
    async pinned(room = null) {
      await ensure();
      const rows = await db.query(
        `SELECT ${COLS} FROM messages WHERE pinned_at IS NOT NULL AND ($1::text IS NULL OR room = $1::text) ORDER BY id`,
        [room],
      );
      return rows.map(toMessage);
    },
    async setPinned(id, pinned, title) {
      await ensure();
      const rows = await db.query(
        `UPDATE messages
            SET pinned_at = CASE WHEN $2::boolean THEN coalesce(pinned_at, now()) END,
                pin_title = CASE WHEN $2::boolean THEN coalesce($3::text, pin_title) END
          WHERE id = $1::bigint RETURNING ${COLS}`,
        [id, Boolean(pinned), title ?? null],
      );
      return rows[0] ? toMessage(rows[0]) : null;
    },
    async setPinTitle(id, title) {
      await ensure();
      const rows = await db.query(
        `UPDATE messages SET pin_title = $2::text
         WHERE id = $1::bigint AND pinned_at IS NOT NULL RETURNING ${COLS}`,
        [id, title],
      );
      if (rows[0]) return toMessage(rows[0]);
      const [exists] = await db.query(`SELECT id FROM messages WHERE id = $1::bigint`, [id]);
      return exists ? 'not-pinned' : null;
    },
    async all(room = null) {
      await ensure();
      return (await db.query(`SELECT ${COLS} FROM messages WHERE ($1::text IS NULL OR room = $1::text) ORDER BY id`, [room])).map(toMessage);
    },
    async version(room = null) {
      await ensure();
      const [row] = await db.query(
        `SELECT (SELECT coalesce(max(id), 0) FROM messages WHERE ($1::text IS NULL OR room = $1::text)) AS last_id,
                (SELECT coalesce(string_agg(id::text || ':' || coalesce(pin_title, ''), ',' ORDER BY id), '') FROM messages
                  WHERE pinned_at IS NOT NULL AND ($1::text IS NULL OR room = $1::text)) AS pins,
                ${POLLS_FINGERPRINT_SQL} AS polls,
                ${REACTIONS_FINGERPRINT_SQL} AS reactions,
                ${DECISIONS_FINGERPRINT_SQL} AS decisions,
                ${READS_FINGERPRINT_SQL} AS reads,
                ${ROOMS_FINGERPRINT_SQL} AS rooms`,
        [room],
      );
      return { last_id: Number(row.last_id), pins: String(row.pins), polls: String(row.polls), reactions: String(row.reactions), decisions: String(row.decisions), reads: String(row.reads), rooms: String(row.rooms) };
    },
    async listRooms({ seen = null, me = null } = {}) {
      await ensure();
      return (await db.query(ROOMS_SQL, [seen ? JSON.stringify(seen) : null, me, null])).map(toRoom);
    },
    async getRoom(id) {
      await ensure();
      const [row] = await db.query(ROOMS_SQL, [null, null, id]);
      return row ? toRoom(row) : null;
    },
    async createRoom({ id, name, created_by }) {
      await ensure();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${ROOM_LOCK_ID})`, []);
        const existing = await tx.query(`SELECT id FROM rooms`, []);
        if (existing.some((r) => r.id === id)) throw new RoomError('exists', id);
        if (existing.length >= MAX_ROOMS) throw new RoomError('full', id);
        const [row] = await tx.query(
          `INSERT INTO rooms (id, name, created_by) VALUES ($1::text, $2::text, $3::text)
           RETURNING id, name, created_at, created_by`,
          [id, name, created_by],
        );
        return toRoom(row);
      });
    },
    async claimWakeup() {
      await ensure();
      return db.transaction(async (tx) => {
        // The row lock makes concurrent jobs take turns, so a range is claimed by exactly one of them.
        const [state] = await tx.query(`SELECT last_notified_id FROM webhook_state WHERE id = 1 FOR UPDATE`, []);
        const previous = Number(state.last_notified_id);
        const [range] = await tx.query(
          `SELECT min(id) AS first_id, max(id) AS last_id, count(*)::int AS n
           FROM messages WHERE id > $1::bigint AND ${WAKES_GROK}`,
          [previous],
        );
        if (!range.n) return null;
        await tx.query(`UPDATE webhook_state SET last_notified_id = $1::bigint WHERE id = 1`, [range.last_id]);
        return { first_id: Number(range.first_id), last_id: Number(range.last_id), count: range.n as number, previous_id: previous };
      });
    },
    async releaseWakeup(claim) {
      await ensure();
      const rows = await db.query(
        `UPDATE webhook_state SET last_notified_id = $1::bigint
         WHERE id = 1 AND last_notified_id = $2::bigint RETURNING id`,
        [claim.previous_id, claim.last_id],
      );
      return rows.length > 0;
    },
    async setWakeTarget(participant, url, secret) {
      await ensure();
      const [row] = await db.query(
        `INSERT INTO wake_targets (participant, url, secret, updated_at)
         VALUES ($1::text, $2::text, $3::text, now())
         ON CONFLICT (participant) DO UPDATE
           SET url = EXCLUDED.url, secret = EXCLUDED.secret, updated_at = now()
         RETURNING url, updated_at`,
        [participant, url, secret],
      );
      return { url: String(row.url), updated_at: iso(row.updated_at)! };
    },
    async getWakeTarget(participant) {
      await ensure();
      const [row] = await db.query(`SELECT url, updated_at FROM wake_targets WHERE participant = $1::text`, [participant]);
      return row ? { url: String(row.url), updated_at: iso(row.updated_at)! } : null;
    },
    async getWakeCredentials(participant) {
      await ensure();
      const [row] = await db.query(`SELECT url, secret FROM wake_targets WHERE participant = $1::text`, [participant]);
      return row ? { url: String(row.url), secret: String(row.secret) } : null;
    },
    async clearWakeTarget(participant) {
      await ensure();
      const rows = await db.query(`DELETE FROM wake_targets WHERE participant = $1::text RETURNING participant`, [participant]);
      return rows.length > 0;
    },
    async enqueueWakes(messageId, participants) {
      await ensure();
      for (const name of participants) {
        await db.query(
          `INSERT INTO wake_deliveries (message_id, participant, status, attempts)
           VALUES ($1::bigint, $2::text, 'pending', 0)
           ON CONFLICT (message_id, participant) DO NOTHING`,
          [messageId, name],
        );
      }
    },
    async enqueueWakesForPinTitle(messageId, participants) {
      await ensure();
      for (const name of participants) {
        await db.query(
          `INSERT INTO wake_deliveries (message_id, participant, status, attempts)
           VALUES ($1::bigint, $2::text, 'pending', 0)
           ON CONFLICT (message_id, participant) DO UPDATE
             SET status = 'pending', attempts = 0, error = NULL, updated_at = now()
             WHERE wake_deliveries.status IN ('delivered', 'failed')`,
          [messageId, name],
        );
      }
    },
    async listPendingWakes() {
      await ensure();
      const rows = await db.query(
        `SELECT d.message_id, d.participant, m.sender, m.recipient, m.text, m.room, m.pinned_at, m.pin_title
         FROM wake_deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.status = 'pending'
         ORDER BY d.message_id, d.participant`,
        [],
      );
      return rows.map(toPendingWake);
    },
    async claimPendingWakes() {
      await ensure();
      return db.transaction(async (tx) => {
        const rows = await tx.query(
          `UPDATE wake_deliveries d
           SET status = 'sending', updated_at = now()
           FROM (
             SELECT message_id, participant
             FROM wake_deliveries
             WHERE status = 'pending'
                OR (status = 'sending' AND updated_at < now() - interval '1 minute')
             ORDER BY message_id, participant
             FOR UPDATE SKIP LOCKED
           ) due
           JOIN messages m ON m.id = due.message_id
           WHERE d.message_id = due.message_id AND d.participant = due.participant
           RETURNING d.message_id, d.participant, m.sender, m.recipient, m.text, m.room, m.pinned_at, m.pin_title`,
          [],
        );
        return rows
          .map(toPendingWake)
          .sort((a, b) => a.message_id - b.message_id || a.participant.localeCompare(b.participant));
      });
    },
    async listWakeTargets() {
      await ensure();
      const rows = await db.query(`SELECT participant, url, updated_at FROM wake_targets ORDER BY participant`, []);
      return rows.map((r) => ({ participant: String(r.participant) as Sender, url: String(r.url), updated_at: iso(r.updated_at)! }));
    },
    async takeWakeTestSlot(participant, limitPerMin = WAKE_TEST_PER_MIN) {
      await ensure();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${WAKE_TEST_LOCK_ID})`, []);
        await tx.query(`DELETE FROM wake_test_events WHERE created_at <= now() - interval '60 seconds'`, []);
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM wake_test_events WHERE participant = $1::text AND created_at > now() - interval '60 seconds'`,
          [participant],
        );
        if ((n as number) >= limitPerMin) return false;
        await tx.query(`INSERT INTO wake_test_events (participant) VALUES ($1::text)`, [participant]);
        return true;
      });
    },
    async saveWakeDelivery(messageId, participant, status, attempts, error) {
      await ensure();
      const [row] = await db.query(
        `INSERT INTO wake_deliveries (message_id, participant, status, attempts, error, updated_at)
         VALUES ($1::bigint, $2::text, $3::text, $4::int, $5::text, now())
         ON CONFLICT (message_id, participant) DO UPDATE
           SET status = EXCLUDED.status, attempts = EXCLUDED.attempts, error = EXCLUDED.error, updated_at = now()
         RETURNING message_id, participant, status, attempts, error, updated_at`,
        [messageId, participant, status, attempts, error],
      );
      return toWakeDelivery(row);
    },
    async listWakes(messageIds) {
      await ensure();
      if (!messageIds.length) return [];
      const rows = await db.query(
        `SELECT message_id, participant, status, attempts, error, updated_at
         FROM wake_deliveries
         WHERE message_id = ANY($1::bigint[])
         ORDER BY message_id, participant`,
        [messageIds],
      );
      return rows.map(toWakeDelivery);
    },
    async listWakingMessages({ participant, since, limit, humans, agents, room = null }) {
      await ensure();
      if (!agents.includes(participant)) return [];
      const rows = since === null
        ? await db.query(
          `SELECT * FROM (SELECT ${COLS} FROM messages
             WHERE sender <> 'hub'
               AND sender <> $1::text
               AND (
                 sender = ANY($2::text[])
                 OR (sender = ANY($3::text[]) AND (recipient IS NULL OR recipient = $1::text))
               )
               AND ($5::text IS NULL OR room = $5::text)
             ORDER BY id DESC LIMIT $4::int) t ORDER BY id`,
          [participant, humans, agents, limit, room],
        )
        : await db.query(
          `SELECT ${COLS} FROM messages
           WHERE id > $1::bigint
             AND sender <> 'hub'
             AND sender <> $2::text
             AND (
               sender = ANY($3::text[])
               OR (sender = ANY($4::text[]) AND (recipient IS NULL OR recipient = $2::text))
             )
             AND ($6::text IS NULL OR room = $6::text)
           ORDER BY id ASC
           LIMIT $5::int`,
          [since, participant, humans, agents, limit, room],
        );
      return rows.map(toMessage);
    },
        async setStatus({ participant, text, ttlSeconds }) {
      await ensure();
      const [row] = await db.query(
        `INSERT INTO participant_status (participant, text, expires_at, updated_at)
         VALUES ($1::text, $2::text, now() + $3::int * interval '1 second', now())
         ON CONFLICT (participant) DO UPDATE
           SET text = EXCLUDED.text,
               expires_at = EXCLUDED.expires_at,
               updated_at = EXCLUDED.updated_at
         RETURNING participant, text, expires_at, updated_at`,
        [participant, text, ttlSeconds],
      );
      return toStatus(row);
    },
    async clearStatus(participant) {
      await ensure();
      const rows = await db.query(
        `DELETE FROM participant_status WHERE participant = $1::text RETURNING participant`,
        [participant],
      );
      return rows.length > 0;
    },
    async listStatuses() {
      await ensure();
      await db.query(`DELETE FROM participant_status WHERE expires_at <= now()`, []);
      const rows = await db.query(
        `SELECT participant, text, expires_at, updated_at
         FROM participant_status
         WHERE expires_at > now()
         ORDER BY updated_at DESC, participant`,
        [],
      );
      return rows.map(toStatus);
    },
    async createPoll({ creator, question, options, recipient = null, room = null }, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      recipient = notToSelf(creator, recipient);
      const id = newPollId();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [creator],
        );
        if ((n as number) >= limitPerMin) return null;
        const rows = await tx.query(
          `INSERT INTO messages (sender, recipient, text, room)
           VALUES ($1::text, $2::text, $3::text, $4::text)
           RETURNING ${BASE_COLS}`,
          [creator, recipient, question, await roomFor(tx, room, null)],
        );
        await tx.query(
          `INSERT INTO polls (id, message_id, creator, question, options)
           VALUES ($1::text, $2::bigint, $3::text, $4::text, $5::text[])`,
          [id, rows[0].id, creator, question, options],
        );
        const [pollRow] = await tx.query(`SELECT ${POLL_JSON} AS poll FROM polls p WHERE p.id = $1::text`, [id]);
        const poll = toPoll(pollRow.poll);
        if (!poll) throw new Error('poll was not stored');
        return { message: { ...toMessage(rows[0]), attachments: [], poll }, poll };
      });
    },
    async getPoll(id) {
      await ensure();
      const [row] = await db.query(`SELECT ${POLL_JSON} AS poll FROM polls p WHERE p.id = $1::text`, [id]);
      return row ? toPoll(row.poll) : null;
    },
    async listPolls(room = null) {
      await ensure();
      const rows = await db.query(
        `SELECT ${POLL_JSON} AS poll FROM polls p
         WHERE (p.closed_at IS NULL OR p.closed_at > now() - interval '24 hours')
           AND ${inRoomSql('p.message_id')}
         ORDER BY p.created_at, p.id`,
        [room],
      );
      return rows.map((r) => toPoll(r.poll)).filter((p): p is Poll => p !== null);
    },
    async listPollMessages() {
      await ensure();
      const rows = await db.query(
        `SELECT ${COLS} FROM messages WHERE id IN (SELECT message_id FROM polls) ORDER BY id`,
        [],
      );
      return rows.map(toMessage);
    },
    async listMessagesByIds(ids) {
      await ensure();
      if (!ids.length) return [];
      const rows = await db.query(
        `SELECT ${COLS} FROM messages WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [ids],
      );
      return rows.map(toMessage);
    },
    async vote(pollId, participant, option) {
      await ensure();
      return db.transaction(async (tx) => {
        const [poll] = await tx.query(
          `SELECT id, closed_at, cardinality(options) AS n FROM polls WHERE id = $1::text FOR UPDATE`,
          [pollId],
        );
        if (!poll) throw new PollError('not found');
        if (poll.closed_at) throw new PollError('closed');
        if (option < 1 || option > Number(poll.n)) throw new PollError('bad option');
        await tx.query(
          `INSERT INTO poll_votes (poll_id, participant, option_index)
           VALUES ($1::text, $2::text, $3::int)
           ON CONFLICT (poll_id, participant) DO UPDATE
             SET option_index = EXCLUDED.option_index, updated_at = now()`,
          [pollId, participant, option],
        );
        const [row] = await tx.query(`SELECT ${POLL_JSON} AS poll FROM polls p WHERE p.id = $1::text`, [pollId]);
        const result = toPoll(row.poll);
        if (!result) throw new PollError('not found');
        return result;
      });
    },
    async unvote(pollId, participant) {
      await ensure();
      return db.transaction(async (tx) => {
        const [poll] = await tx.query(`SELECT id, closed_at FROM polls WHERE id = $1::text FOR UPDATE`, [pollId]);
        if (!poll) throw new PollError('not found');
        if (poll.closed_at) throw new PollError('closed');
        const gone = await tx.query(
          `DELETE FROM poll_votes WHERE poll_id = $1::text AND participant = $2::text RETURNING participant`,
          [pollId, participant],
        );
        const [row] = await tx.query(`SELECT ${POLL_JSON} AS poll FROM polls p WHERE p.id = $1::text`, [pollId]);
        const result = toPoll(row.poll);
        if (!result) throw new PollError('not found');
        return { poll: result, withdrawn: gone.length > 0 };
      });
    },
    async closePoll(pollId, participant, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        const [existing] = await tx.query(
          `SELECT creator, closed_at, message_id FROM polls WHERE id = $1::text FOR UPDATE`,
          [pollId],
        );
        if (!existing) throw new PollError('not found');
        if (existing.creator !== participant) throw new PollError('not the creator');
        if (existing.closed_at) {
          const [row] = await tx.query(`SELECT ${POLL_JSON} AS poll FROM polls p WHERE p.id = $1::text`, [pollId]);
          const poll = toPoll(row.poll);
          if (!poll) throw new PollError('not found');
          return { poll, message: null };
        }
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [participant],
        );
        if ((n as number) >= limitPerMin) return null;
        await tx.query(`UPDATE polls SET closed_at = now() WHERE id = $1::text`, [pollId]);
        const [row] = await tx.query(`SELECT ${POLL_JSON} AS poll FROM polls p WHERE p.id = $1::text`, [pollId]);
        const poll = toPoll(row.poll);
        if (!poll) throw new PollError('not found');
        // The result is a reply to the poll, so it is in the poll's room.
        const inserted = await tx.query(
          `INSERT INTO messages (sender, recipient, text, reply_to, room)
           VALUES ($1::text, NULL, $2::text, $3::bigint, (SELECT room FROM messages WHERE id = $3::bigint))
           RETURNING ${BASE_COLS}`,
          [participant, pollResultText(poll), existing.message_id],
        );
        return { poll, message: { ...toMessage(inserted[0]), attachments: [], poll: null } };
      });
    },
    async addReaction(messageId, participant, emoji, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${REACTION_LOCK_ID})`, []);
        const [exists] = await tx.query(`SELECT id FROM messages WHERE id = $1::bigint`, [messageId]);
        if (!exists) return { status: 'not_found' as const };
        const [already] = await tx.query(
          `SELECT 1 FROM reactions WHERE message_id = $1::bigint AND participant = $2::text AND emoji = $3::text`,
          [messageId, participant, emoji],
        );
        if (!already) {
          const [{ n }] = await tx.query(
            `SELECT count(*)::int AS n FROM reactions
             WHERE participant = $1::text AND created_at > now() - interval '60 seconds'`,
            [participant],
          );
          if ((n as number) >= limitPerMin) return { status: 'rate_limited' as const };
          await tx.query(
            `INSERT INTO reactions (message_id, participant, emoji)
             VALUES ($1::bigint, $2::text, $3::text)`,
            [messageId, participant, emoji],
          );
        }
        const [row] = await tx.query(`SELECT ${COLS} FROM messages WHERE id = $1::bigint`, [messageId]);
        return { status: 'ok' as const, message: toMessage(row) };
      });
    },
    async removeReaction(messageId, participant, emoji) {
      await ensure();
      const [exists] = await db.query(`SELECT id FROM messages WHERE id = $1::bigint`, [messageId]);
      if (!exists) return null;
      await db.query(
        `DELETE FROM reactions WHERE message_id = $1::bigint AND participant = $2::text AND emoji = $3::text`,
        [messageId, participant, emoji],
      );
      const [row] = await db.query(`SELECT ${COLS} FROM messages WHERE id = $1::bigint`, [messageId]);
      return toMessage(row);
    },
    async listReactions(room = null) {
      await ensure();
      const rows = await db.query(
        `SELECT message_id,
                (SELECT coalesce(json_agg(json_build_object('emoji', g.emoji, 'by', g.by) ORDER BY g.first_at, g.emoji), '[]'::json)
                   FROM (
                     SELECT emoji,
                            json_agg(participant ORDER BY created_at, participant) AS by,
                            min(created_at) AS first_at
                       FROM reactions r2
                      WHERE r2.message_id = r.message_id
                      GROUP BY emoji
                   ) g) AS reactions
           FROM (SELECT DISTINCT message_id FROM reactions) r
          WHERE ${inRoomSql('r.message_id')}
          ORDER BY message_id`,
        [room],
      );
      return rows.map(toMessageReactions);
    },

    async createDecision({ creator, prompt, recipient = null, reply_to = null, room = null }, roster = [], limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      recipient = notToSelf(creator, recipient);
      const id = newDecisionId();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        const inRoom = await roomFor(tx, room, reply_to);
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [creator],
        );
        if ((n as number) >= limitPerMin) return null;
        const rows = await tx.query(
          `INSERT INTO messages (sender, recipient, text, reply_to, room)
           VALUES ($1::text, $2::text, $3::text, $4::bigint, $5::text)
           RETURNING ${BASE_COLS}`,
          [creator, recipient, prompt, reply_to, inRoom],
        );
        await tx.query(
          `INSERT INTO decision_cards (id, message_id, creator, prompt)
           VALUES ($1::text, $2::bigint, $3::text, $4::text)`,
          [id, rows[0].id, creator, prompt],
        );
        // Proposing counts as agreeing: the creator is not left waiting on their own card.
        await tx.query(
          `INSERT INTO decision_positions (card_id, participant, stance, note)
           VALUES ($1::text, $2::text, 'agree', NULL)`,
          [id, creator],
        );
        const [cardRow] = await tx.query(`SELECT ${DECISION_JSON} AS decision FROM decision_cards c WHERE c.id = $1::text`, [id]);
        const decision = toDecision(cardRow.decision);
        if (!decision) throw new Error('decision card was not stored');
        if (decisionIsAgreed(decision, roster)) {
          const [{ at }] = await tx.query(`SELECT now() AS at`, []);
          await tx.query(`UPDATE decision_cards SET agreed_at = $2::timestamptz WHERE id = $1::text`, [id, at]);
          await tx.query(`UPDATE messages SET pinned_at = coalesce(pinned_at, $2::timestamptz) WHERE id = $1::bigint`, [rows[0].id, at]);
          const [fresh] = await tx.query(`SELECT ${DECISION_JSON} AS decision FROM decision_cards c WHERE c.id = $1::text`, [id]);
          const [msg] = await tx.query(`SELECT ${COLS} FROM messages WHERE id = $1::bigint`, [rows[0].id]);
          const agreed = toDecision(fresh.decision);
          if (!agreed) throw new Error('decision card was not stored');
          return { message: toMessage(msg), decision: agreed };
        }
        return { message: { ...toMessage(rows[0]), attachments: [], poll: null, decision, reactions: [] }, decision };
      });
    },
    async recordDecisionPosition(cardId, participant, stance, note, roster, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      if (stance === 'object' && !note) throw new DecisionError('note required');
      return db.transaction(async (tx) => {
        // The same message lock as a post, so a reply is id-ordered and rate-limited like one.
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        const [card] = await tx.query(`SELECT id, message_id, agreed_at FROM decision_cards WHERE id = $1::text FOR UPDATE`, [cardId]);
        if (!card) throw new DecisionError('not found');
        const [already] = await tx.query(
          `SELECT stance, note FROM decision_positions WHERE card_id = $1::text AND participant = $2::text`,
          [cardId, participant],
        );
        const same = already && already.stance === stance && (already.note ?? null) === (note ?? null);
        if (same) {
          const [freshCard] = await tx.query(`SELECT ${DECISION_JSON} AS decision FROM decision_cards c WHERE c.id = $1::text`, [cardId]);
          const [row] = await tx.query(`SELECT ${COLS} FROM messages WHERE id = $1::bigint`, [card.message_id]);
          const fresh = toDecision(freshCard.decision);
          if (!fresh) throw new DecisionError('not found');
          return { status: 'ok' as const, decision: fresh, message: toMessage(row), reply: null };
        }
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [participant],
        );
        if ((n as number) >= limitPerMin) return { status: 'rate_limited' as const };
        await tx.query(
          `INSERT INTO decision_positions (card_id, participant, stance, note)
           VALUES ($1::text, $2::text, $3::text, $4::text)
           ON CONFLICT (card_id, participant) DO UPDATE
             SET stance = EXCLUDED.stance, note = EXCLUDED.note, updated_at = now()`,
          [cardId, participant, stance, note],
        );
        const [cardRow] = await tx.query(`SELECT ${DECISION_JSON} AS decision FROM decision_cards c WHERE c.id = $1::text`, [cardId]);
        const decision = toDecision(cardRow.decision);
        if (!decision) throw new DecisionError('not found');
        const agreed = decisionIsAgreed(decision, roster);
        const wasAgreed = card.agreed_at != null;
        const [{ at }] = await tx.query(`SELECT now() AS at`, []);
        // When everyone has agreed, the card is a decision: pin it, using one timestamp so we can
        // take the pin back later if consensus breaks. If that stops being true, unpin only when
        // we were the ones who pinned it (pinned_at equals agreed_at).
        if (agreed) {
          await tx.query(
            `UPDATE decision_cards SET agreed_at = coalesce(agreed_at, $2::timestamptz) WHERE id = $1::text`,
            [cardId, at],
          );
          await tx.query(
            `UPDATE messages SET pinned_at = coalesce(pinned_at, $2::timestamptz) WHERE id = $1::bigint`,
            [card.message_id, at],
          );
        } else {
          await tx.query(
            `UPDATE messages SET pinned_at = NULL, pin_title = NULL
              WHERE id = $1::bigint
                AND pinned_at IS NOT NULL
                AND pinned_at = (SELECT agreed_at FROM decision_cards WHERE id = $2::text)`,
            [card.message_id, cardId],
          );
          await tx.query(`UPDATE decision_cards SET agreed_at = NULL WHERE id = $1::text`, [cardId]);
        }
        const consensus = !wasAgreed && agreed ? 'agreed' as const : wasAgreed && !agreed ? 'broken' as const : null;
        // The note about the position is a reply to the card, so it is in the card's room.
        const inserted = await tx.query(
          `INSERT INTO messages (sender, recipient, text, reply_to, room)
           VALUES ($1::text, NULL, $2::text, $3::bigint, (SELECT room FROM messages WHERE id = $3::bigint))
           RETURNING ${BASE_COLS}`,
          [participant, decisionPositionText(stance, note, consensus), card.message_id],
        );
        const [freshCard] = await tx.query(`SELECT ${DECISION_JSON} AS decision FROM decision_cards c WHERE c.id = $1::text`, [cardId]);
        const [row] = await tx.query(`SELECT ${COLS} FROM messages WHERE id = $1::bigint`, [card.message_id]);
        const fresh = toDecision(freshCard.decision);
        if (!fresh) throw new DecisionError('not found');
        return { status: 'ok' as const, decision: fresh, message: toMessage(row), reply: { ...toMessage(inserted[0]), attachments: [], poll: null, decision: null, reactions: [] } };
      });
    },
    async listDecisions(room = null) {
      await ensure();
      const rows = await db.query(
        `SELECT ${DECISION_JSON} AS decision FROM decision_cards c WHERE ${inRoomSql('c.message_id')} ORDER BY c.created_at, c.id`,
        [room],
      );
      return rows.map((r) => toDecision(r.decision)).filter((d): d is DecisionCard => d !== null);
    },
    async setReadPosition(participant, upTo, room = null) {
      await ensure();
      // The position is recorded in the room the message is in. The message says which room that is.
      const [message] = await db.query(`SELECT room FROM messages WHERE id = $1::bigint`, [upTo]);
      if (!message) throw new ReadError('not found');
      const inRoom = message.room as string;
      if (room !== null && room !== inRoom) throw new RoomError('read elsewhere', room, { id: upTo, room: inRoom });
      const rows = await db.query(
        `INSERT INTO read_positions (participant, room, up_to)
         VALUES ($1::text, $3::text, $2::bigint)
         ON CONFLICT (participant, room) DO UPDATE
           SET up_to = EXCLUDED.up_to, updated_at = now()
           WHERE read_positions.up_to < EXCLUDED.up_to
         RETURNING participant, room, up_to, updated_at`,
        [participant, upTo, inRoom],
      );
      const row = rows[0] ?? (await db.query(
        `SELECT participant, room, up_to, updated_at FROM read_positions WHERE participant = $1::text AND room = $2::text`,
        [participant, inRoom],
      ))[0];
      return toRead(row);
    },
    async listReads(room = null) {
      await ensure();
      const rows = await db.query(
        `SELECT participant, room, up_to, updated_at FROM read_positions
         WHERE ($1::text IS NULL OR room = $1::text) ORDER BY participant, room`,
        [room],
      );
      return rows.map(toRead);
    },
  };
}

export interface MemoryStoreOptions extends StoreOptions {
  blobs?: Blobs;
  /** The clock, in milliseconds. Tests move it forward to age uploads. */
  now?: () => number;
}

/** In-memory store with the same behaviour (local development and tests only). */
export function createMemoryStore({ blobs = createMemoryBlobs(), now = Date.now, welcome = defaultWelcome() }: MemoryStoreOptions = {}): Store {
  const rows: Message[] = [];
  let nextId = 1;
  const timestamp = () => new Date(now()).toISOString();
  const push = (r: Partial<Message> & { sender: Author; text: string }): Message => {
    const m: Message = { id: nextId++, recipient: null, pinned_at: null, pin_title: null, created_at: timestamp(), room: MAIN_ROOM, attachments: [], reply_to: null, poll: null, decision: null, reactions: [], ...r };
    rows.push(m);
    return m;
  };
  const roomRows: Omit<Room, 'last_id' | 'unread'>[] = [{ id: MAIN_ROOM, name: 'Main', created_at: timestamp(), created_by: 'hub' }];
  const inRoom = (room: string | null) => (m: Message): boolean => room === null || m.room === room;
  /** Whether what hangs on this message (a poll, reactions, a decision card) is in `room`. Null: every room. */
  const messageInRoom = (id: number, room: string | null): boolean => room === null || rows.find((m) => m.id === id)?.room === room;
  const assembleRoom = (r: Omit<Room, 'last_id' | 'unread'>, seen: Readonly<Record<string, number>> | null, me: Sender | null): Room => {
    const own = rows.filter((m) => m.room === r.id);
    const room: Room = { ...r, last_id: own.length ? own[own.length - 1].id : 0 };
    if (seen) room.unread = own.filter((m) => m.id > (seen[r.id] ?? 0) && m.sender !== me).length;
    return room;
  };
  /** The same rule as the SQL store's roomFor. */
  const roomFor = (room: string | null, replyTo: number | null): string => {
    const parent = replyTo === null ? undefined : rows.find((m) => m.id === replyTo);
    if (replyTo !== null && !parent) throw new ReplyTargetError(replyTo);
    if (room === null) return parent?.room ?? MAIN_ROOM;
    if (parent && parent.room !== room) throw new RoomError('other room', room, { id: parent.id, room: parent.room });
    if (!roomRows.some((r) => r.id === room)) throw new RoomError('not found', room);
    return room;
  };
  push({ sender: 'hub', text: welcome });
  // The same check the database makes, so a name that Postgres would refuse is refused here too.
  const shaped = (name: string): string => {
    if (!NAME_PATTERN.test(name)) throw new Error('A stored name must have the shape of a participant name.');
    return name;
  };
  type PollRow = { id: string; message_id: number; creator: Sender; question: string; options: string[]; closed_at: string | null; created_at: string };
  type VoteRow = { poll_id: string; participant: Sender; option_index: number; created_at: string; updated_at: string };
  const pollRows = new Map<string, PollRow>();
  const voteRows = new Map<string, VoteRow>();
  const voteKey = (pollId: string, participant: Sender) => `${pollId}\0${participant}`;
  const assemblePoll = (row: PollRow): Poll => ({
    id: row.id,
    message_id: row.message_id,
    creator: row.creator,
    question: row.question,
    closed_at: row.closed_at,
    created_at: row.created_at,
    options: row.options.map((optText, i) => {
      const index = i + 1;
      const voters = [...voteRows.values()]
        .filter((v) => v.poll_id === row.id && v.option_index === index)
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.participant.localeCompare(b.participant))
        .map((v) => v.participant);
      return { index, text: optText, votes: voters.length, voters };
    }),
  });
  const pollForMessage = (messageId: number): Poll | null => {
    const row = [...pollRows.values()].find((p) => p.message_id === messageId);
    return row ? assemblePoll(row) : null;
  };
  const pollsFingerprint = (): string => {
    const entries = [...pollRows.values()]
      .sort((a, b) => a.message_id - b.message_id || a.id.localeCompare(b.id))
      .map((p) => {
        const votes = [...voteRows.values()].filter((v) => v.poll_id === p.id);
        const latestVote = votes.reduce((latest, v) => (latest === '' || v.updated_at > latest ? v.updated_at : latest), '');
        const latest = [latestVote, p.closed_at, p.created_at].filter((t): t is string => Boolean(t)).sort().at(-1) ?? '';
        return `${p.message_id}:${votes.length}:${latest}`;
      });
    return `${pollRows.size}|${entries.join(',')}`;
  };
  const requireOpenPoll = (pollId: string): PollRow => {
    const row = pollRows.get(pollId);
    if (!row) throw new PollError('not found');
    if (row.closed_at) throw new PollError('closed');
    return row;
  };
  type ReactionRow = { message_id: number; participant: Sender; emoji: string; created_at: string };
  const reactionRows: ReactionRow[] = [];
  const reactionsOn = (messageId: number): Reaction[] => {
    const grouped = new Map<string, { by: Sender[]; first: string; index: number }>();
    for (const r of reactionRows) {
      if (r.message_id !== messageId) continue;
      const g = grouped.get(r.emoji);
      if (g) g.by.push(r.participant);
      else grouped.set(r.emoji, { by: [r.participant], first: r.created_at, index: grouped.size });
    }
    return [...grouped.entries()]
      .sort((a, b) => a[1].first.localeCompare(b[1].first) || a[1].index - b[1].index)
      .map(([emoji, g]) => ({ emoji, by: g.by }));
  };
  const reactionsFingerprint = (): string => {
    const byMessage = new Map<number, { n: number; latest: string }>();
    let latest = '';
    for (const r of reactionRows) {
      const cur = byMessage.get(r.message_id);
      if (!cur) byMessage.set(r.message_id, { n: 1, latest: r.created_at });
      else {
        cur.n += 1;
        if (r.created_at > cur.latest) cur.latest = r.created_at;
      }
      if (r.created_at > latest) latest = r.created_at;
    }
    const body = [...byMessage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, row]) => `${id}:${row.n}:${row.latest}`)
      .join(',');
    return `${reactionRows.length}|${latest}|${body}`;
  };
  type DecisionRow = { id: string; message_id: number; creator: Sender; prompt: string; created_at: string; agreed_at: string | null };
  type PositionRow = { card_id: string; participant: Sender; stance: DecisionStance; note: string | null; updated_at: string };
  const decisionRows = new Map<string, DecisionRow>();
  const positionRows = new Map<string, PositionRow>();
  type ReadRow = { participant: Sender; room: string; up_to: number; updated_at: string };
  const readRows = new Map<string, ReadRow>(); // one per participant and room
  const readKey = (participant: Sender, room: string) => `${participant}\0${room}`;
  const positionKey = (cardId: string, participant: Sender) => `${cardId}\0${participant}`;
  const assembleDecision = (row: DecisionRow): DecisionCard => ({
    id: row.id,
    message_id: row.message_id,
    creator: row.creator,
    prompt: row.prompt,
    created_at: row.created_at,
    agreed_at: row.agreed_at,
    positions: [...positionRows.values()]
      .filter((p) => p.card_id === row.id)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.participant.localeCompare(b.participant))
      .map((p) => ({ participant: p.participant, stance: p.stance, note: p.note, updated_at: p.updated_at })),
  });
  const decisionForMessage = (messageId: number): DecisionCard | null => {
    const row = [...decisionRows.values()].find((c) => c.message_id === messageId);
    return row ? assembleDecision(row) : null;
  };
  const decisionsFingerprint = (): string => {
    const entries = [...decisionRows.values()]
      .sort((a, b) => a.message_id - b.message_id || a.id.localeCompare(b.id))
      .map((c) => {
        const positions = [...positionRows.values()].filter((p) => p.card_id === c.id);
        const agree = positions.filter((p) => p.stance === 'agree').length;
        const object = positions.filter((p) => p.stance === 'object').length;
        const latestPos = positions.reduce((latest, p) => (latest === '' || p.updated_at > latest ? p.updated_at : latest), '');
        const latest = [latestPos, c.agreed_at, c.created_at].filter((x): x is string => Boolean(x)).sort().at(-1) ?? '';
        return `${c.message_id}:${agree}:${object}:${latest}`;
      });
    return `${decisionRows.size}|${entries.join(',')}`;
  };
  const readsFingerprint = (room: string | null): string => {
    const own = [...readRows.values()].filter((r) => room === null || r.room === room);
    const entries = own
      .sort((a, b) => a.participant.localeCompare(b.participant) || a.room.localeCompare(b.room))
      .map((r) => `${r.participant}:${r.up_to}`);
    return `${own.length}|${entries.join(',')}`;
  };
  const copy = (m: Message): Message => ({
    ...m,
    attachments: m.attachments.map((a) => ({ ...a })),
    poll: pollForMessage(m.id),
    decision: decisionForMessage(m.id),
    reactions: reactionsOn(m.id).map((r) => ({ emoji: r.emoji, by: [...r.by] })),
  });
  let lastNotifiedId = 0; // like a fresh database; the welcome message never wakes Grok anyway
  const wakeTargets = new Map<string, { url: string; secret: string; updated_at: string }>();
  const wakeDeliveries = new Map<string, WakeDelivery>();
  let wakeTestEvents: { participant: string; at: number }[] = [];
  const uploads = new Map<string, StoredAttachment & { created: number }>();
  const statuses = new Map<Sender, ParticipantStatus>();
  const meta = ({ id, content_type, width, height, bytes, scale }: Attachment): Attachment => ({ id, content_type, width, height, bytes, scale });
  const noDb = { query: async () => [] }; // the memory blobs don't use a database
  return {
    async ensure() {},
    async add({ sender, recipient, text, pinned, attachments = [], reply_to = null, room = null }, limitPerMin = RATE_LIMIT_PER_MIN) {
      const cutoff = now() - 60_000;
      recipient = notToSelf(sender, recipient);
      const recent = rows.filter((m) => m.sender === sender && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return null;
      const target = roomFor(room, reply_to);
      const linked = attachments.map((id) => {
        const upload = uploads.get(id);
        if (!upload) throw new AttachmentLinkError(id, 'unknown');
        if (upload.sender !== sender) throw new AttachmentLinkError(id, 'not yours');
        if (upload.message_id !== null) throw new AttachmentLinkError(id, 'already linked');
        return upload;
      });
      const m = push({ sender: shaped(sender), recipient: recipient ? shaped(recipient) : null, text, pinned_at: pinned ? timestamp() : null, attachments: linked.map(meta), reply_to, room: target });
      for (const upload of linked) upload.message_id = m.id;
      return copy(m);
    },
    async addAttachment({ sender, content_type, width, height, data, scale = 1 }, limitPerHour = UPLOADS_PER_HOUR) {
      // The same check the database makes.
      if (!Number.isInteger(scale) || scale < 1 || scale > MAX_SCALE) throw new Error(`An image's scale must be a whole number from 1 to ${MAX_SCALE}.`);
      const removed = [...uploads.values()].filter((u) => u.message_id === null && u.created < now() - ORPHAN_MAX_AGE_MS).map((u) => u.id);
      for (const id of removed) uploads.delete(id);
      if (removed.length) await blobs.delete(noDb, removed);
      const recent = [...uploads.values()].filter((u) => u.sender === sender && u.created > now() - 60 * 60 * 1000).length;
      if (recent >= limitPerHour) return null;
      const attachment: Attachment = { id: newAttachmentId(), content_type, width, height, bytes: data.length, scale };
      await blobs.put(noDb, attachment.id, data);
      uploads.set(attachment.id, { ...attachment, sender, message_id: null, created: now() });
      return attachment;
    },
    async uploadsInLastHour(sender) {
      return [...uploads.values()].filter((u) => u.sender === sender && u.created > now() - 60 * 60 * 1000).length;
    },
    async getAttachment(id) {
      const upload = uploads.get(id);
      const data = upload && (await blobs.get(noDb, id));
      if (!upload || !data) return null;
      return { attachment: { ...meta(upload), sender: upload.sender, message_id: upload.message_id }, data };
    },
    async list({ since = null, to = null, limit = 200, room = null } = {}) {
      const match = rows.filter((m) => (to === null || m.recipient === to) && (since === null || m.id > since) && (room === null || m.room === room));
      return (since === null ? match.slice(-limit) : match.slice(0, limit)).map(copy);
    },
    async search({ words, to = null, decisionsAmong = null, pinned = false, limit = SEARCH_LIMIT, room = null }) {
      if (!words.length) return [];
      return rows.filter(inRoom(room)).map(copy)
        .filter((m) => (to === null || m.recipient === to) && (!pinned || m.pinned_at) && (!decisionsAmong || isDecision(m.text, decisionsAmong, m.decision)) && matchesAll(m, words))
        .reverse().slice(0, limit);
    },
    async pinned(room = null) { return rows.filter((m) => m.pinned_at).filter(inRoom(room)).map(copy); },
    async setPinned(id, pinned, title) {
      const m = rows.find((r) => r.id === id);
      if (!m) return null;
      if (pinned) {
        m.pinned_at = m.pinned_at ?? timestamp();
        if (title !== undefined) m.pin_title = title;
      } else {
        m.pinned_at = null;
        m.pin_title = null;
      }
      return copy(m);
    },
    async setPinTitle(id, title) {
      const m = rows.find((r) => r.id === id);
      if (!m) return null;
      if (!m.pinned_at) return 'not-pinned';
      m.pin_title = title;
      return copy(m);
    },
    async all(room = null) { return rows.filter(inRoom(room)).map(copy); },
    async version(room = null) {
      const own = rows.filter(inRoom(room));
      return {
        last_id: own.length ? own[own.length - 1].id : 0,
        pins: own.filter((m) => m.pinned_at).map((m) => `${m.id}:${m.pin_title ?? ''}`).join(','),
        polls: pollsFingerprint(), reactions: reactionsFingerprint(), decisions: decisionsFingerprint(), reads: readsFingerprint(room),
        rooms: roomRows.map((r) => `${r.id}:${assembleRoom(r, null, null).last_id}`).sort().join(','),
      };
    },
    async listRooms({ seen = null, me = null } = {}) {
      return roomRows.map((r) => assembleRoom(r, seen, me));
    },
    async getRoom(id) {
      const row = roomRows.find((r) => r.id === id);
      return row ? assembleRoom(row, null, null) : null;
    },
    async createRoom({ id, name, created_by }) {
      // The same checks the database makes.
      if (!NAME_PATTERN.test(id)) throw new Error('A room id must have the shape of a participant name.');
      if (!name || [...name].length > ROOM_NAME_MAX_LENGTH) throw new Error(`A room name has 1 to ${ROOM_NAME_MAX_LENGTH} characters.`);
      if (roomRows.some((r) => r.id === id)) throw new RoomError('exists', id);
      if (roomRows.length >= MAX_ROOMS) throw new RoomError('full', id);
      const row = { id, name, created_at: timestamp(), created_by: shaped(created_by) };
      roomRows.push(row);
      return assembleRoom(row, null, null);
    },
    async claimWakeup() {
      const fresh = rows.filter((m) => m.id > lastNotifiedId && wakesGrok(m));
      if (!fresh.length) return null;
      const claim = { first_id: fresh[0].id, last_id: fresh[fresh.length - 1].id, count: fresh.length, previous_id: lastNotifiedId };
      lastNotifiedId = claim.last_id;
      return claim;
    },
    async releaseWakeup(claim) {
      if (lastNotifiedId !== claim.last_id) return false;
      lastNotifiedId = claim.previous_id;
      return true;
    },
    async setWakeTarget(participant, url, secret) {
      const info = { url, updated_at: timestamp() };
      wakeTargets.set(participant, { ...info, secret });
      return { ...info };
    },
    async getWakeTarget(participant) {
      const row = wakeTargets.get(participant);
      return row ? { url: row.url, updated_at: row.updated_at } : null;
    },
    async getWakeCredentials(participant) {
      const row = wakeTargets.get(participant);
      return row ? { url: row.url, secret: row.secret } : null;
    },
    async clearWakeTarget(participant) {
      return wakeTargets.delete(participant);
    },
    async enqueueWakes(messageId, participants) {
      const at = timestamp();
      for (const name of participants) {
        const key = `${messageId}:${name}`;
        if (!wakeDeliveries.has(key)) {
          wakeDeliveries.set(key, { message_id: messageId, participant: name, status: 'pending', attempts: 0, error: null, updated_at: at });
        }
      }
    },
    async enqueueWakesForPinTitle(messageId, participants) {
      const at = timestamp();
      for (const name of participants) {
        const key = `${messageId}:${name}`;
        const existing = wakeDeliveries.get(key);
        if (!existing) {
          wakeDeliveries.set(key, { message_id: messageId, participant: name, status: 'pending', attempts: 0, error: null, updated_at: at });
        } else if (existing.status === 'delivered' || existing.status === 'failed') {
          existing.status = 'pending';
          existing.attempts = 0;
          existing.error = null;
          existing.updated_at = at;
        }
      }
    },
    async listPendingWakes() {
      const out: PendingWake[] = [];
      for (const d of [...wakeDeliveries.values()].sort((a, b) => a.message_id - b.message_id || a.participant.localeCompare(b.participant))) {
        if (d.status !== 'pending') continue;
        const m = rows.find((r) => r.id === d.message_id);
        if (!m) continue;
        out.push({ message_id: m.id, participant: d.participant, sender: m.sender, recipient: m.recipient, text: m.text, room: m.room, needs_pin_title: Boolean(m.pinned_at && !m.pin_title) });
      }
      return out;
    },
    async claimPendingWakes() {
      const staleBefore = now() - WAKE_SENDING_STALE_MS;
      const out: PendingWake[] = [];
      for (const d of [...wakeDeliveries.values()].sort((a, b) => a.message_id - b.message_id || a.participant.localeCompare(b.participant))) {
        const stale = d.status === 'sending' && Date.parse(d.updated_at) < staleBefore;
        if (d.status !== 'pending' && !stale) continue;
        const m = rows.find((r) => r.id === d.message_id);
        if (!m) continue;
        d.status = 'sending';
        d.updated_at = timestamp();
        out.push({ message_id: m.id, participant: d.participant, sender: m.sender, recipient: m.recipient, text: m.text, room: m.room, needs_pin_title: Boolean(m.pinned_at && !m.pin_title) });
      }
      return out;
    },
    async listWakeTargets() {
      return [...wakeTargets.entries()]
        .map(([participant, row]) => ({ participant, url: row.url, updated_at: row.updated_at }))
        .sort((a, b) => a.participant.localeCompare(b.participant));
    },
    async takeWakeTestSlot(participant, limitPerMin = WAKE_TEST_PER_MIN) {
      const cutoff = now() - 60_000;
      const recent = wakeTestEvents.filter((e) => e.participant === participant && e.at > cutoff);
      wakeTestEvents = wakeTestEvents.filter((e) => e.at > cutoff);
      if (recent.length >= limitPerMin) return false;
      wakeTestEvents.push({ participant, at: now() });
      return true;
    },
    async saveWakeDelivery(messageId, participant, status, attempts, error) {
      const row: WakeDelivery = { message_id: messageId, participant, status, attempts, error, updated_at: timestamp() };
      wakeDeliveries.set(`${messageId}:${participant}`, row);
      return { ...row };
    },
    async listWakes(messageIds) {
      const wanted = new Set(messageIds);
      return [...wakeDeliveries.values()]
        .filter((d) => wanted.has(d.message_id))
        .sort((a, b) => a.message_id - b.message_id || a.participant.localeCompare(b.participant))
        .map((d) => ({ ...d }));
    },
    async listWakingMessages({ participant, since, limit, humans, agents, room = null }) {
      if (!agents.includes(participant)) return [];
      const humanSet = new Set(humans);
      const agentSet = new Set(agents);
      const match = rows.filter((m) => {
        if (m.sender === 'hub' || m.sender === participant) return false;
        if (room !== null && m.room !== room) return false;
        if (since !== null && m.id <= since) return false;
        if (humanSet.has(m.sender)) return true;
        return agentSet.has(m.sender) && (m.recipient === null || m.recipient === participant);
      });
      return (since === null ? match.slice(-limit) : match.slice(0, limit)).map(copy);
    },
        async setStatus({ participant, text, ttlSeconds }) {
      const current = now();
      const status: ParticipantStatus = {
        participant,
        text,
        expires_at: new Date(current + ttlSeconds * 1000).toISOString(),
        updated_at: new Date(current).toISOString(),
      };
      statuses.set(participant, status);
      return { ...status };
    },
    async clearStatus(participant) {
      return statuses.delete(participant);
    },
    async listStatuses() {
      const current = now();
      for (const [participant, status] of statuses) {
        if (Date.parse(status.expires_at) <= current) statuses.delete(participant);
      }
      return [...statuses.values()]
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.participant.localeCompare(b.participant))
        .map((s) => ({ ...s }));
    },
    async createPoll({ creator, question, options, recipient = null, room = null }, limitPerMin = RATE_LIMIT_PER_MIN) {
      const cutoff = now() - 60_000;
      recipient = notToSelf(creator, recipient);
      const recent = rows.filter((m) => m.sender === creator && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return null;
      const m = push({ sender: shaped(creator), recipient: recipient ? shaped(recipient) : null, text: question, room: roomFor(room, null) });
      const row: PollRow = {
        id: newPollId(),
        message_id: m.id,
        creator,
        question,
        options: [...options],
        closed_at: null,
        created_at: m.created_at,
      };
      pollRows.set(row.id, row);
      const poll = assemblePoll(row);
      return { message: copy(m), poll };
    },
    async getPoll(id) {
      const row = pollRows.get(id);
      return row ? assemblePoll(row) : null;
    },
    async listPolls(room = null) {
      const cutoff = now() - RECENTLY_CLOSED_MS;
      return [...pollRows.values()]
        .filter((p) => (!p.closed_at || Date.parse(p.closed_at) > cutoff) && messageInRoom(p.message_id, room))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))
        .map(assemblePoll);
    },
    async listPollMessages() {
      return rows.filter((m) => pollForMessage(m.id)).map(copy);
    },
    async listMessagesByIds(ids) {
      const want = new Set(ids);
      return rows.filter((m) => want.has(m.id)).map(copy);
    },
    async vote(pollId, participant, option) {
      shaped(participant);
      const row = requireOpenPoll(pollId);
      if (option < 1 || option > row.options.length) throw new PollError('bad option');
      const current = timestamp();
      const key = voteKey(pollId, participant);
      const existing = voteRows.get(key);
      voteRows.set(key, {
        poll_id: pollId,
        participant,
        option_index: option,
        created_at: existing?.created_at ?? current,
        updated_at: current,
      });
      return assemblePoll(row);
    },
    async unvote(pollId, participant) {
      requireOpenPoll(pollId);
      const withdrawn = voteRows.delete(voteKey(pollId, participant));
      const row = pollRows.get(pollId);
      if (!row) throw new PollError('not found');
      return { poll: assemblePoll(row), withdrawn };
    },
    async closePoll(pollId, participant, limitPerMin = RATE_LIMIT_PER_MIN) {
      const row = pollRows.get(pollId);
      if (!row) throw new PollError('not found');
      if (row.creator !== participant) throw new PollError('not the creator');
      if (row.closed_at) return { poll: assemblePoll(row), message: null };
      const cutoff = now() - 60_000;
      const recent = rows.filter((m) => m.sender === participant && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return null;
      row.closed_at = timestamp();
      const poll = assemblePoll(row);
      const message = push({
        sender: participant,
        recipient: null,
        text: pollResultText(poll),
        reply_to: row.message_id,
        room: roomFor(null, row.message_id),
      });
      return { poll, message: copy(message) };
    },
    async addReaction(messageId, participant, emoji, limitPerMin = RATE_LIMIT_PER_MIN) {
      shaped(participant);
      if (!rows.some((m) => m.id === messageId)) return { status: 'not_found' as const };
      if (!reactionRows.some((r) => r.message_id === messageId && r.participant === participant && r.emoji === emoji)) {
        const cutoff = now() - 60_000;
        const recent = reactionRows.filter((r) => r.participant === participant && Date.parse(r.created_at) > cutoff).length;
        if (recent >= limitPerMin) return { status: 'rate_limited' as const };
        reactionRows.push({ message_id: messageId, participant, emoji, created_at: timestamp() });
      }
      return { status: 'ok' as const, message: copy(rows.find((m) => m.id === messageId)!) };
    },
    async removeReaction(messageId, participant, emoji) {
      const m = rows.find((r) => r.id === messageId);
      if (!m) return null;
      const i = reactionRows.findIndex((r) => r.message_id === messageId && r.participant === participant && r.emoji === emoji);
      if (i >= 0) reactionRows.splice(i, 1);
      return copy(m);
    },
    async listReactions(room = null) {
      const ids = [...new Set(reactionRows.map((r) => r.message_id))].filter((id) => messageInRoom(id, room)).sort((a, b) => a - b);
      return ids.map((message_id) => ({ message_id, reactions: reactionsOn(message_id) }));
    },
    async createDecision({ creator, prompt, recipient = null, reply_to = null, room = null }, roster = [], limitPerMin = RATE_LIMIT_PER_MIN) {
      shaped(creator);
      const target = roomFor(room, reply_to);
      const cutoff = now() - 60_000;
      const recent = rows.filter((m) => m.sender === creator && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return null;
      const message = push({ sender: creator, recipient: notToSelf(creator, recipient), text: prompt, reply_to: reply_to ?? null, room: target });
      const row: DecisionRow = { id: newDecisionId(), message_id: message.id, creator, prompt, created_at: message.created_at, agreed_at: null };
      decisionRows.set(row.id, row);
      positionRows.set(positionKey(row.id, creator), { card_id: row.id, participant: creator, stance: 'agree', note: null, updated_at: message.created_at });
      if (decisionIsAgreed(assembleDecision(row), roster)) {
        row.agreed_at = message.created_at;
        message.pinned_at = message.pinned_at ?? row.agreed_at;
      }
      const decision = assembleDecision(row);
      return { message: copy(message), decision };
    },
    async recordDecisionPosition(cardId, participant, stance, note, roster, limitPerMin = RATE_LIMIT_PER_MIN) {
      shaped(participant);
      if (stance === 'object' && !note) throw new DecisionError('note required');
      const row = decisionRows.get(cardId);
      if (!row) throw new DecisionError('not found');
      const key = positionKey(cardId, participant);
      const existing = positionRows.get(key);
      const same = existing && existing.stance === stance && existing.note === (note ?? null);
      const message = rows.find((m) => m.id === row.message_id);
      if (!message) throw new DecisionError('not found');
      if (same) return { status: 'ok' as const, decision: assembleDecision(row), message: copy(message), reply: null };
      const cutoff = now() - 60_000;
      const recent = rows.filter((m) => m.sender === participant && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return { status: 'rate_limited' as const };
      positionRows.set(key, { card_id: cardId, participant, stance, note: note ?? null, updated_at: timestamp() });
      const current = assembleDecision(row);
      const agreed = decisionIsAgreed(current, roster);
      const wasAgreed = row.agreed_at != null;
      if (agreed) {
        row.agreed_at = row.agreed_at ?? timestamp();
        message.pinned_at = message.pinned_at ?? row.agreed_at;
      } else {
        if (message.pinned_at && row.agreed_at && message.pinned_at === row.agreed_at) { message.pinned_at = null; message.pin_title = null; }
        row.agreed_at = null;
      }
      const consensus = !wasAgreed && agreed ? 'agreed' as const : wasAgreed && !agreed ? 'broken' as const : null;
      const reply = push({
        sender: participant,
        recipient: null,
        text: decisionPositionText(stance, note, consensus),
        reply_to: row.message_id,
        room: message.room,
      });
      return { status: 'ok' as const, decision: assembleDecision(row), message: copy(message), reply: copy(reply) };
    },
    async listDecisions(room = null) {
      return [...decisionRows.values()]
        .filter((c) => messageInRoom(c.message_id, room))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))
        .map(assembleDecision);
    },
    async setReadPosition(participant, upTo, room = null) {
      shaped(participant);
      const message = rows.find((m) => m.id === upTo);
      if (!message) throw new ReadError('not found');
      if (room !== null && room !== message.room) throw new RoomError('read elsewhere', room, { id: upTo, room: message.room });
      const existing = readRows.get(readKey(participant, message.room));
      if (existing && existing.up_to >= upTo) return { ...existing };
      const row: ReadRow = { participant, room: message.room, up_to: upTo, updated_at: timestamp() };
      readRows.set(readKey(participant, message.room), row);
      return { ...row };
    },
    async listReads(room = null) {
      return [...readRows.values()]
        .filter((r) => room === null || r.room === room)
        .sort((a, b) => a.participant.localeCompare(b.participant) || a.room.localeCompare(b.room))
        .map((r) => ({ ...r }));
    },
  };
}

/** Db on a `pg` Pool, registered with Vercel so idle connections are closed cleanly on Fluid compute. */
async function createPgDb(connectionString: string): Promise<Db> {
  const { Pool } = await import('pg');
  const { attachDatabasePool } = await import('@vercel/functions');
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 5_000 });
  attachDatabasePool(pool);
  return {
    async query(text, params) {
      return (await pool.query(text, params)).rows as Row[];
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (text, params) => (await client.query(text, params)).rows as Row[] });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

const globalStore = globalThis as typeof globalThis & { __collabHubStore?: Promise<Store> };

/** One store per server instance. */
export function getStore(): Promise<Store> {
  if (!globalStore.__collabHubStore) {
    const url = process.env.DATABASE_URL;
    // Only a new, empty hub uses this: an existing one keeps the welcome message it has.
    const welcome = welcomeText(loadRoster().participants);
    if (url) {
      globalStore.__collabHubStore = createPgDb(url).then((db) => createSqlStore(db, undefined, { welcome })).catch((e: unknown) => {
        globalStore.__collabHubStore = undefined; // retry on the next request
        throw e;
      });
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn('[trialog] DATABASE_URL is not set: using an in-memory store (messages are lost on restart).');
      globalStore.__collabHubStore = Promise.resolve(createMemoryStore({ welcome }));
    } else {
      return Promise.reject(new Error('DATABASE_URL is not set.'));
    }
  }
  return globalStore.__collabHubStore;
}
