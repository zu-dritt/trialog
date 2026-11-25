// Message storage. Production uses Neon Postgres through `pg` on the pooled DATABASE_URL.
// The same SQL store is tested against PGlite. Without DATABASE_URL, `next dev` falls back to
// an in-memory store (lost on restart) so the page can be tried locally; production refuses.
import { RATE_LIMIT_PER_MIN, WELCOME_TEXT, type Author, type Message, type Sender } from './core';

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
export interface StreamVersion {
  last_id: number;
  pins: string;
}
export interface Store {
  ensure(): Promise<void>;
  /** Returns the stored message, or null when the sender is over the rate limit. */
  add(input: NewMessage, limitPerMin?: number): Promise<Message | null>;
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
];
export const SCHEMA_SQL = SCHEMA.join(';\n\n') + ';\n';

const COLS = 'id, sender, recipient, text, created_at, pinned_at';
// Inserts take a transaction-level advisory lock so ids are committed in order: a poller asking
// for "since=<id>" can never skip a message that committed late with a lower id. Transaction-level
// locks work behind Neon's pooler (PgBouncer in transaction mode).
const LOCK_ID = 7230418;
// Messages that wake Grok: addressed to Grok or to everyone, and not written by Grok or the hub.
const WAKES_GROK = `sender NOT IN ('grok', 'hub') AND (recipient IS NULL OR recipient = 'grok')`;
export const wakesGrok = (m: Pick<Message, 'sender' | 'recipient'>): boolean =>
  m.sender !== 'grok' && m.sender !== 'hub' && (m.recipient === null || m.recipient === 'grok');

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const toMessage = (r: Row): Message => ({
  id: Number(r.id),
  sender: r.sender as Author,
  recipient: (r.recipient as Sender | null) ?? null,
  text: r.text as string,
  created_at: iso(r.created_at) as string,
  pinned_at: iso(r.pinned_at),
});

/** SQL store on top of a Db (pg in production, PGlite in tests). */
export function createSqlStore(db: Db): Store {
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
    async add({ sender, recipient, text, pinned }, limitPerMin = RATE_LIMIT_PER_MIN) {
      await ensure();
      return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_ID})`, []);
        // Counted after taking the lock, so concurrent posts by one sender can't both slip past the limit.
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM messages WHERE sender = $1::text AND created_at > now() - interval '60 seconds'`,
          [sender],
        );
        if ((n as number) >= limitPerMin) return null;
        const rows = await tx.query(
          `INSERT INTO messages (sender, recipient, text, pinned_at)
           VALUES ($1::text, $2::text, $3::text, CASE WHEN $4::boolean THEN now() END)
           RETURNING ${COLS}`,
          [sender, recipient, text, Boolean(pinned)],
        );
        return toMessage(rows[0]);
      });
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
  };
}

/** In-memory store with the same behaviour (local development and tests only). */
export function createMemoryStore(): Store {
  const rows: Message[] = [];
  let nextId = 1;
  const push = (r: Partial<Message> & { sender: Author; text: string }): Message => {
    const m: Message = { id: nextId++, recipient: null, pinned_at: null, created_at: new Date().toISOString(), ...r };
    rows.push(m);
    return m;
  };
  push({ sender: 'hub', text: WELCOME_TEXT });
  const copy = (m: Message): Message => ({ ...m });
  let lastNotifiedId = 0; // like a fresh database; the welcome message never wakes Grok anyway
  return {
    async ensure() {},
    async add({ sender, recipient, text, pinned }, limitPerMin = RATE_LIMIT_PER_MIN) {
      const cutoff = Date.now() - 60_000;
      const recent = rows.filter((m) => m.sender === sender && Date.parse(m.created_at) > cutoff).length;
      if (recent >= limitPerMin) return null;
      return copy(push({ sender, recipient: recipient ?? null, text, pinned_at: pinned ? new Date().toISOString() : null }));
    },
    async list({ since = null, to = null, limit = 200 } = {}) {
      const match = rows.filter((m) => (to === null || m.recipient === to) && (since === null || m.id > since));
      return (since === null ? match.slice(-limit) : match.slice(0, limit)).map(copy);
    },
    async pinned() { return rows.filter((m) => m.pinned_at).map(copy); },
    async setPinned(id, pinned) {
      const m = rows.find((r) => r.id === id);
      if (!m) return null;
      m.pinned_at = pinned ? (m.pinned_at ?? new Date().toISOString()) : null;
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
      globalStore.__collabHubStore = createPgDb(url).then(createSqlStore).catch((e: unknown) => {
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
