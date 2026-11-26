// Message storage. Production uses Neon Postgres through `pg` on the pooled DATABASE_URL.
// The same SQL store is tested against PGlite. Without DATABASE_URL, `next dev` falls back to
// an in-memory store (lost on restart) so the page can be tried locally; production refuses.
//
// Image attachments: this file keeps their rows (who, size, which message). Their bytes are read
// and written only through lib/blobs.ts.
import { randomBytes } from 'node:crypto';
import { createMemoryBlobs, createSqlBlobs, type Blobs } from './blobs';
import {
  MAX_ATTACHMENT_BYTES, ORPHAN_MAX_AGE_MS, RATE_LIMIT_PER_MIN, UPLOADS_PER_HOUR, WELCOME_TEXT,
  type Attachment, type Author, type ImageType, type Message, type ParticipantStatus, type Sender,
} from './core';

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
}
/** An image that has already been checked and re-encoded (lib/images.ts). */
export interface NewAttachment {
  sender: Sender;
  content_type: ImageType;
  width: number;
  height: number;
  data: Buffer;
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
export interface ListOptions {
  since?: number | null;
  to?: Sender | null;
  limit?: number;
}
/** A range of messages one wake-up webhook covers. `previous_id` is what the watermark was before the claim. */
export interface WakeupClaim {
  first_id: number;
  last_id: number;
  count: number;
  previous_id: number;
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
}
export interface Store {
  ensure(): Promise<void>;
  /**
   * Returns the stored message, or null when the sender is over the rate limit.
   * Throws AttachmentLinkError when one of `attachments` is unknown, someone else's or already linked,
   * and ReplyTargetError when `reply_to` names a message that does not exist.
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
  pinned(): Promise<Message[]>;
  setPinned(id: number, pinned: boolean): Promise<Message | null>;
  all(): Promise<Message[]>;
  /** A cheap fingerprint of the stream: the newest message id and the ids of the pinned messages. */
  version(): Promise<StreamVersion>;
  /**
   * Claims every message Grok has not been woken for yet (addressed to Grok or to everyone, not
   * written by Grok or the hub) and moves the watermark past them. Returns null when there is
   * nothing new, which means another job already covered it.
   */
  claimWakeup(): Promise<WakeupClaim | null>;
  /** After a failed delivery: puts the watermark back, unless a later claim has moved it on. */
  releaseWakeup(claim: WakeupClaim): Promise<boolean>;
  /** Sets or replaces the caller's active working status with a TTL in seconds. */
  setStatus(input: SetStatusInput): Promise<ParticipantStatus>;
  /** Clears the caller's working status; returns true if a row existed. */
  clearStatus(participant: Sender): Promise<boolean>;
  /** Active (non-expired) statuses for all participants; lazily drops expired rows. */
  listStatuses(): Promise<ParticipantStatus[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id         BIGSERIAL PRIMARY KEY,
     sender     TEXT NOT NULL CHECK (sender IN ('grok', 'claude', 'david', 'hub')),
     recipient  TEXT CHECK (recipient IN ('grok', 'claude', 'david')),
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
  // Replies (migrations/004-replies.sql): a message can name the earlier message it answers.
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
];
export const SCHEMA_SQL = SCHEMA.join(';\n\n') + ';\n';

const BASE_COLS = 'id, sender, recipient, text, created_at, pinned_at, reply_to';
const ATTACHMENT_COLS = 'id, content_type, width, height, bytes';
// Every message comes back with its attachments (never their bytes), in the order the sender gave.
const COLS = `${BASE_COLS},
  (SELECT coalesce(json_agg(json_build_object('id', a.id, 'content_type', a.content_type,
            'width', a.width, 'height', a.height, 'bytes', a.bytes) ORDER BY a.position, a.id), '[]'::json)
     FROM attachments a WHERE a.message_id = messages.id) AS attachments`;
// Inserts take a transaction-level advisory lock so ids are committed in order: a poller asking
// for "since=<id>" can never skip a message that committed late with a lower id. Transaction-level
// locks work behind Neon's pooler (PgBouncer in transaction mode).
const LOCK_ID = 7230418;
// Uploads take their own lock, so a slow upload never holds up posting. It makes the hourly count
// exact when one sender uploads several images at once.
const UPLOAD_LOCK_ID = 7230419;
const ORPHAN_SECONDS = ORPHAN_MAX_AGE_MS / 1000;
const newAttachmentId = (): string => `att_${randomBytes(12).toString('hex')}`;
// Messages that wake Grok: addressed to Grok or to everyone, and not written by Grok or the hub.
const WAKES_GROK = `sender NOT IN ('grok', 'hub') AND (recipient IS NULL OR recipient = 'grok')`;
export const wakesGrok = (m: Pick<Message, 'sender' | 'recipient'>): boolean =>
  m.sender !== 'grok' && m.sender !== 'hub' && (m.recipient === null || m.recipient === 'grok');

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const toAttachment = (r: Row): Attachment => ({
  id: r.id as string,
  content_type: r.content_type as ImageType,
  width: Number(r.width),
  height: Number(r.height),
  bytes: Number(r.bytes),
});
/** The json column arrives parsed from pg and PGlite; a string is handled in case a driver doesn't. */
const toAttachments = (v: unknown): Attachment[] => {
  const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(list) ? (list as Row[]).map(toAttachment) : [];
};
const toStatus = (r: Row): ParticipantStatus => ({
  participant: r.participant as Sender,
  text: r.text as string,
  expires_at: iso(r.expires_at) as string,
  updated_at: iso(r.updated_at) as string,
});
const toMessage = (r: Row): Message => ({
  id: Number(r.id),
  sender: r.sender as Author,
  recipient: (r.recipient as Sender | null) ?? null,
  text: r.text as string,
  created_at: iso(r.created_at) as string,
  pinned_at: iso(r.pinned_at),
  attachments: toAttachments(r.attachments),
  reply_to: r.reply_to == null ? null : Number(r.reply_to),
});

/** SQL store on top of a Db (pg in production, PGlite in tests). */
export function createSqlStore(db: Db, blobs: Blobs = createSqlBlobs()): Store {
  let ready: Promise<void> | null = null;
  async function init() {
    for (const stmt of SCHEMA) await db.query(stmt, []);
    await db.query(
      `INSERT INTO messages (sender, text)
       SELECT 'hub', $1::text WHERE NOT EXISTS (SELECT 1 FROM messages)
       ON CONFLICT (sender) WHERE sender = 'hub' DO NOTHING`,
      [WELCOME_TEXT],
    );
  }
  function ensure(): Promise<void> {
    if (!ready) {
      // Retry once: two cold starts can race on CREATE TABLE IF NOT EXISTS.
      ready = init().catch(() => init()).catch((e: unknown) => { ready = null; throw e; });
    }
    return ready;
  }

  return {
    ensure,
    async add({ sender, recipient, text, pinned, attachments = [], reply_to = null }, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        // Counted after taking the lock, so concurrent posts by one sender can't both slip past the limit.
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [sender],
        );
        if ((n as number) >= limitPerMin) return null;
        // A reply must answer a message that exists. The foreign key would refuse it too; asking
        // first gives the sender a clear answer instead of a database error.
        if (reply_to !== null) {
          const found = await tx.query(`SELECT 1 FROM messages WHERE id = $1::bigint`, [reply_to]);
          if (!found.length) throw new ReplyTargetError(reply_to);
        }
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
          `INSERT INTO messages (sender, recipient, text, pinned_at, reply_to)
           VALUES ($1::text, $2::text, $3::text, CASE WHEN $4::boolean THEN now() END, $5::bigint)
           RETURNING ${BASE_COLS}`,
          [sender, recipient, text, Boolean(pinned), reply_to],
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
    async addAttachment({ sender, content_type, width, height, data }, limitPerHour = UPLOADS_PER_HOUR) {
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
          `INSERT INTO attachments (id, sender, content_type, bytes, width, height)
           VALUES ($1::text, $2::text, $3::text, $4::int, $5::int, $6::int)`,
          [id, sender, content_type, data.length, width, height],
        );
        await blobs.put(tx, id, data);
        return { id, content_type, width, height, bytes: data.length };
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
    async list({ since = null, to = null, limit = 200 } = {}) {
      await ensure();
      const rows = since === null
        ? await db.query(
          `SELECT * FROM (SELECT ${COLS} FROM messages
             WHERE ($1::text IS NULL OR recipient = $1::text)
             ORDER BY id DESC LIMIT $2::int) t ORDER BY id`,
          [to, limit],
        )
        : await db.query(
          `SELECT ${COLS} FROM messages
           WHERE id > $1::bigint AND ($2::text IS NULL OR recipient = $2::text)
           ORDER BY id LIMIT $3::int`,
          [since, to, limit],
        );
      return rows.map(toMessage);
    },
    async pinned() {
      await ensure();
      const rows = await db.query(`SELECT ${COLS} FROM messages WHERE pinned_at IS NOT NULL ORDER BY id`, []);
      return rows.map(toMessage);
    },
    async setPinned(id, pinned) {
      await ensure();
      const rows = await db.query(
        `UPDATE messages SET pinned_at = CASE WHEN $2::boolean THEN coalesce(pinned_at, now()) END
         WHERE id = $1::bigint RETURNING ${COLS}`,
        [id, Boolean(pinned)],
      );
      return rows[0] ? toMessage(rows[0]) : null;
    },
    async all() {
      await ensure();
      return (await db.query(`SELECT ${COLS} FROM messages ORDER BY id`, [])).map(toMessage);
    },
    async version() {
      await ensure();
      const [row] = await db.query(
        `SELECT (SELECT coalesce(max(id), 0) FROM messages) AS last_id,
                (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM messages WHERE pinned_at IS NOT NULL) AS pins`,
        [],
      );
      return { last_id: Number(row.last_id), pins: String(row.pins) };
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
  };
}

export interface MemoryStoreOptions {
  blobs?: Blobs;
  /** The clock, in milliseconds. Tests move it forward to age uploads. */
  now?: () => number;
}

/** In-memory store with the same behaviour (local development and tests only). */
export function createMemoryStore({ blobs = createMemoryBlobs(), now = Date.now }: MemoryStoreOptions = {}): Store {
  const rows: Message[] = [];
  let nextId = 1;
  const timestamp = () => new Date(now()).toISOString();
  const push = (r: Partial<Message> & { sender: Author; text: string }): Message => {
    const m: Message = { id: nextId++, recipient: null, pinned_at: null, created_at: timestamp(), attachments: [], reply_to: null, ...r };
    rows.push(m);
    return m;
  };
  push({ sender: 'hub', text: WELCOME_TEXT });
  const copy = (m: Message): Message => ({ ...m, attachments: m.attachments.map((a) => ({ ...a })) });
  let lastNotifiedId = 0; // like a fresh database; the welcome message never wakes Grok anyway
  const uploads = new Map<string, StoredAttachment & { created: number }>();
  const statuses = new Map<Sender, ParticipantStatus>();
  const meta = ({ id, content_type, width, height, bytes }: Attachment): Attachment => ({ id, content_type, width, height, bytes });
  const noDb = { query: async () => [] }; // the memory blobs don't use a database
  return {
    async ensure() {},
    async add({ sender, recipient, text, pinned, attachments = [], reply_to = null }, limitPerMin = RATE_LIMIT_PER_MIN) {
      const cutoff = now() - 60_000;
      const recent = rows.filter((m) => m.sender === sender && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return null;
      if (reply_to !== null && !rows.some((m) => m.id === reply_to)) throw new ReplyTargetError(reply_to);
      const linked = attachments.map((id) => {
        const upload = uploads.get(id);
        if (!upload) throw new AttachmentLinkError(id, 'unknown');
        if (upload.sender !== sender) throw new AttachmentLinkError(id, 'not yours');
        if (upload.message_id !== null) throw new AttachmentLinkError(id, 'already linked');
        return upload;
      });
      const m = push({ sender, recipient: recipient ?? null, text, pinned_at: pinned ? timestamp() : null, attachments: linked.map(meta), reply_to });
      for (const upload of linked) upload.message_id = m.id;
      return copy(m);
    },
    async addAttachment({ sender, content_type, width, height, data }, limitPerHour = UPLOADS_PER_HOUR) {
      const removed = [...uploads.values()].filter((u) => u.message_id === null && u.created < now() - ORPHAN_MAX_AGE_MS).map((u) => u.id);
      for (const id of removed) uploads.delete(id);
      if (removed.length) await blobs.delete(noDb, removed);
      const recent = [...uploads.values()].filter((u) => u.sender === sender && u.created > now() - 60 * 60 * 1000).length;
      if (recent >= limitPerHour) return null;
      const attachment: Attachment = { id: newAttachmentId(), content_type, width, height, bytes: data.length };
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
    async list({ since = null, to = null, limit = 200 } = {}) {
      const match = rows.filter((m) => (to === null || m.recipient === to) && (since === null || m.id > since));
      return (since === null ? match.slice(-limit) : match.slice(0, limit)).map(copy);
    },
    async pinned() { return rows.filter((m) => m.pinned_at).map(copy); },
    async setPinned(id, pinned) {
      const m = rows.find((r) => r.id === id);
      if (!m) return null;
      m.pinned_at = pinned ? (m.pinned_at ?? timestamp()) : null;
      return copy(m);
    },
    async all() { return rows.map(copy); },
    async version() {
      return { last_id: rows[rows.length - 1].id, pins: rows.filter((m) => m.pinned_at).map((m) => m.id).join(',') };
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
    if (url) {
      globalStore.__collabHubStore = createPgDb(url).then((db) => createSqlStore(db)).catch((e: unknown) => {
        globalStore.__collabHubStore = undefined; // retry on the next request
        throw e;
      });
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn('[trialog] DATABASE_URL is not set: using an in-memory store (messages are lost on restart).');
      globalStore.__collabHubStore = Promise.resolve(createMemoryStore());
    } else {
      return Promise.reject(new Error('DATABASE_URL is not set.'));
    }
  }
  return globalStore.__collabHubStore;
}
