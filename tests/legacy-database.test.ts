// A hub from before participants were configurable: the old settings (three tokens, no
// PARTICIPANTS) on a database that the old schema created and filled. It must keep working
// unchanged and keep its history. tests/schema-before-any-participants.sql is that old schema,
// byte for byte.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Message, ParticipantStatus } from '../lib/core';
import { SCHEMA_SQL, createSqlStore, type Db, type Row, type Store } from '../lib/store';

const TOKENS: Record<string, string> = {
  grok: 'grok-legacy-token-0123456789abcd',
  claude: 'claude-legacy-token-0123456789ab',
  david: 'david-legacy-token-0123456789abc',
};
const file = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

const IMAGE_ID = 'att_legacy0123456789abcdef';
const IMAGE_BYTES = Buffer.from('bytes stored before the change');

/** A database as the old application left it: old schema, old checks, some history of every kind. */
async function legacyDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(await file('./schema-before-any-participants.sql'));
  await pg.exec(`
    INSERT INTO messages (sender, recipient, text, created_at, pinned_at) VALUES
      ('hub', NULL, 'the welcome text of that time', '2026-11-25T10:00:00Z', NULL),
      ('david', NULL, 'hello both', '2026-11-25T10:01:00Z', NULL),
      ('grok', 'claude', '@claude please review', '2026-11-25T10:02:00Z', NULL),
      ('claude', 'david', 'DECISION: we keep the three colours', '2026-11-25T10:03:00Z', '2026-11-25T10:03:00Z'),
      ('david', 'grok', 'a screenshot', '2026-11-25T10:04:00Z', NULL);
    UPDATE webhook_state SET last_notified_id = 5;
    INSERT INTO participant_status (participant, text, expires_at) VALUES ('grok', 'reviewing', now() + interval '10 minutes');
    INSERT INTO polls (id, message_id, creator, question, options) VALUES ('poll_legacy0123456789abcdef', 2, 'david', 'hello both', ARRAY['yes', 'no']);
    INSERT INTO poll_votes (poll_id, participant, option_index) VALUES ('poll_legacy0123456789abcdef', 'grok', 1), ('poll_legacy0123456789abcdef', 'claude', 2);`);
  await pg.query(
    `INSERT INTO attachments (id, sender, message_id, position, content_type, bytes, width, height, data) VALUES ($1, 'david', 5, 0, 'image/png', $2, 40, 20, $3)`,
    [IMAGE_ID, IMAGE_BYTES.length, IMAGE_BYTES],
  );
  return pg;
}

/**
 * Every row of every table, as text, to compare before and after. The `room` column that rooms
 * added to messages is left out: an old row has `main` there (tests/rooms.test.ts checks that),
 * and everything it had before must be as it was.
 */
async function contents(pg: PGlite): Promise<string> {
  const out: unknown[] = [];
  for (const table of ['messages', 'attachments', 'participant_status', 'webhook_state', 'polls', 'poll_votes']) {
    out.push((await pg.query(`SELECT (to_jsonb(t) - 'room')::text AS row FROM ${table} t ORDER BY 1`)).rows);
  }
  return JSON.stringify(out);
}
/** The CHECK constraints on the columns that hold a name. */
async function nameChecks(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ c: string }>(
    `SELECT conrelid::regclass || '.' || conname || ': ' || pg_get_constraintdef(oid) AS c FROM pg_constraint
     WHERE contype = 'c' AND (pg_get_constraintdef(oid) ~ 'sender|recipient|participant|creator') ORDER BY 1`,
  );
  return rows.map((r) => r.c);
}
const SHAPE_CHECKS = [
  /^attachments\.attachments_sender_shape: CHECK \(\(sender ~ '\^\[a-z\]\[a-z0-9-\]\{0,23\}\$'::text\)\)$/,
  /^decision_cards\.decision_cards_creator_shape: CHECK \(\(creator ~ /,
  /^decision_positions\.decision_positions_participant_shape: CHECK \(\(participant ~ /,
  /^messages\.messages_recipient_shape: CHECK \(\(recipient ~ /,
  /^messages\.messages_sender_shape: CHECK \(\(sender ~ /,
  /^participant_flight\.participant_flight_participant_shape: CHECK \(\(participant ~ /,
  /^participant_status\.participant_status_participant_shape: CHECK \(\(participant ~ /,
  /^poll_votes\.poll_votes_participant_shape: CHECK \(\(participant ~ /,
  /^polls\.polls_creator_shape: CHECK \(\(creator ~ /,
  /^reactions\.reactions_participant_shape: CHECK \(\(participant ~ /,
  /^read_positions\.read_positions_participant_shape: CHECK \(\(participant ~ /,
  /^streak_breaks\.streak_breaks_participant_shape: CHECK \(\(participant ~ /,
  /^wake_deliveries\.wake_deliveries_participant_shape: CHECK \(\(participant ~ /,
  /^wake_targets\.wake_targets_participant_shape: CHECK \(\(participant ~ /,
  /^wake_test_events\.wake_test_events_participant_shape: CHECK \(\(participant ~ /,
];
const assertShapeChecksOnly = async (pg: PGlite) => {
  const checks = await nameChecks(pg);
  assert.equal(checks.length, SHAPE_CHECKS.length, checks.join('\n'));
  for (const [i, expected] of SHAPE_CHECKS.entries()) assert.match(checks[i], expected);
  assert.ok(!checks.join('\n').includes('grok'), 'no check lists names any more');
};

test('the fixture really is the old database: its checks list the three names', async () => {
  const pg = await legacyDatabase();
  const checks = (await nameChecks(pg)).join('\n');
  assert.match(checks, /messages_sender_check: CHECK \(\(sender = ANY \(ARRAY\['grok'::text, 'claude'::text, 'david'::text, 'hub'::text\]\)\)\)/);
  assert.match(checks, /messages_recipient_check/);
  assert.match(checks, /attachments_sender_check/);
  assert.match(checks, /participant_status_participant_check/);
  assert.match(checks, /polls_creator_is_participant/);
  assert.match(checks, /poll_votes_participant_is_participant/);
  await assert.rejects(pg.query(`INSERT INTO messages (sender, text) VALUES ('ana', 'x')`), /check/i);
  await pg.close();
});

test('first request on an old database: every row is kept, and the name checks become shape checks', async () => {
  const pg = await legacyDatabase();
  const before = await contents(pg);
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  assert.equal(await contents(pg), before, 'no row was added, changed or removed');
  await assertShapeChecksOnly(pg);

  // The history reads as it always did, attachments and pins included, and no second welcome appears.
  const all = await store.all();
  assert.deepEqual(all.map((m) => [m.id, m.sender, m.recipient, m.text]), [
    [1, 'hub', null, 'the welcome text of that time'],
    [2, 'david', null, 'hello both'],
    [3, 'grok', 'claude', '@claude please review'],
    [4, 'claude', 'david', 'DECISION: we keep the three colours'],
    [5, 'david', 'grok', 'a screenshot'],
  ]);
  assert.deepEqual(all[4].attachments, [{ id: IMAGE_ID, content_type: 'image/png', width: 40, height: 20, bytes: IMAGE_BYTES.length, scale: 1 }]);
  assert.deepEqual((await store.pinned()).map((m) => m.id), [4]);
  assert.ok((await store.getAttachment(IMAGE_ID))?.data.equals(IMAGE_BYTES));
  assert.deepEqual((await store.listStatuses()).map((s) => [s.participant, s.text]), [['grok', 'reviewing']]);
  assert.equal(await store.claimWakeup(), null, 'old messages wake nobody');

  // New names can be stored now; what is not a name still cannot, whoever writes to the table.
  assert.ok(await store.add({ sender: 'quill-2', recipient: 'ana-maria', text: 'a fourth participant' }));
  await assert.rejects(pg.query(`INSERT INTO messages (sender, text) VALUES ('Not A Name', 'x')`), /messages_sender_shape/);
  await assert.rejects(pg.query(`INSERT INTO messages (sender, recipient, text) VALUES ('grok', 'not_a_name', 'x')`), /messages_recipient_shape/);
  await assert.rejects(pg.query(`INSERT INTO participant_status (participant, text, expires_at) VALUES ('NOPE', 'x', now())`), /participant_status_participant_shape/);
  await assert.rejects(pg.query(`INSERT INTO attachments (id, sender, content_type, bytes, width, height) VALUES ('att_x', 'no pe', 'image/png', 1, 1, 1)`), /attachments_sender_shape/);
  await assert.rejects(pg.query(`INSERT INTO polls (id, message_id, creator, question, options) VALUES ('poll_x', 3, 'No Pe', 'q', ARRAY['a', 'b'])`), /polls_creator_shape/);
  await assert.rejects(pg.query(`INSERT INTO poll_votes (poll_id, participant, option_index) VALUES ('poll_legacy0123456789abcdef', 'NOPE', 1)`), /poll_votes_participant_shape/);
  // The poll from before is as it was, and a fourth participant can vote in it.
  const poll = (await store.all())[1].poll;
  assert.deepEqual(poll?.options.map((o) => [o.text, o.voters]), [['yes', ['grok']], ['no', ['claude']]]);
  const voted = await store.vote('poll_legacy0123456789abcdef', 'quill-2', 1);
  assert.deepEqual(voted.options[0].voters, ['grok', 'quill-2']);
  await pg.close();
});

test('the migration is idempotent: a second start, the migration file and the whole schema change nothing more', async () => {
  const pg = await legacyDatabase();
  await createSqlStore(pgliteDb(pg)).ensure();
  const rows = await contents(pg);
  const checks = await nameChecks(pg);

  await createSqlStore(pgliteDb(pg)).ensure(); // the next cold start
  await Promise.all([createSqlStore(pgliteDb(pg)).ensure(), createSqlStore(pgliteDb(pg)).ensure()]); // two at once
  const migration = await file('../migrations/007-any-participants.sql');
  await pg.exec(migration);
  await pg.exec(migration);
  await pg.exec(await file('../schema.sql'));
  assert.equal(await contents(pg), rows);
  assert.deepEqual(await nameChecks(pg), checks);
  await pg.close();
});

test('an old database, a new database and the migration files by hand all end with the same checks', async () => {
  const migrated = await legacyDatabase();
  await createSqlStore(pgliteDb(migrated)).ensure();

  const fresh = new PGlite();
  await fresh.exec(SCHEMA_SQL);
  await assertShapeChecksOnly(fresh);
  assert.deepEqual(await nameChecks(fresh), await nameChecks(migrated));

  // Someone who applies the files in migrations/ to an old database themselves, without the app.
  const byHand = await legacyDatabase();
  const before = await contents(byHand);
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.includes('007-any-participants.sql'), 'the migration that replaces the name lists is present');
  assert.ok(files.indexOf('007-any-participants.sql') > files.indexOf('006-attachment-scale.sql'), 'it runs after every table that listed names exists');
  assert.ok(files.includes('009-decision-cards.sql'));
  assert.ok(files.indexOf('010-read-markers.sql') > files.indexOf('009-decision-cards.sql'), 'read markers come after decision cards, with the same name check');
  assert.equal(files.at(-1), '015-streak-breaks.sql', 'the streak comes last');
  assert.equal(files.at(-2), '014-work-in-flight.sql', 'work in flight before it');
  assert.equal(files.at(-3), '013-guard.sql', 'the guard before that');
  assert.ok(files.includes('008-reactions.sql'));
  assert.ok(files.includes('010-read-markers.sql'));
  assert.ok(files.indexOf('011-wake-targets.sql') > files.indexOf('010-read-markers.sql'), 'wake-up targets come after read markers, with the same name check');
  for (const name of files) await byHand.exec(await file(`../migrations/${name}`));
  assert.equal(await contents(byHand), before);
  assert.deepEqual(await nameChecks(byHand), await nameChecks(migrated));

  // A database from the very first version, with no checks at all (and no later tables), gets them too.
  const v1 = new PGlite();
  await v1.exec(`CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT, text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), pinned_at TIMESTAMPTZ);
    INSERT INTO messages (sender, recipient, text) VALUES ('hub', NULL, 'welcome'), ('david', 'claude', 'old one');`);
  await createSqlStore(pgliteDb(v1)).ensure();
  assert.deepEqual(await nameChecks(v1), await nameChecks(migrated));
  for (const pg of [migrated, fresh, byHand, v1]) await pg.close();
});

test('going back: the old application still starts on a migrated database', async () => {
  // The old application's first request runs the old schema, which only creates what is missing.
  const pg = await legacyDatabase();
  await createSqlStore(pgliteDb(pg)).ensure();
  const rows = await contents(pg);
  await pg.exec(await file('./schema-before-any-participants.sql'));
  assert.equal(await contents(pg), rows);
  await assertShapeChecksOnly(pg);
  await pg.close();
});

// --- the old settings, through the real routes, on the old database -----------------------------------

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let pg: PGlite;
let messages: { GET: Handler; POST: Handler };
let participants: { GET: Handler };
let exportRoute: { GET: Handler };
let status: { GET: Handler; PUT: Handler };
let image: { GET: Handler };
let pin: { POST: Handler };

beforeAll(async () => {
  // Exactly what an existing deployment has: three tokens, and no PARTICIPANTS.
  delete process.env.PARTICIPANTS;
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  // The routes take their store from here. In production it is the pg pool; here it is the old database.
  pg = await legacyDatabase();
  (globalThis as typeof globalThis & { __collabHubStore?: Promise<Store> }).__collabHubStore = Promise.resolve(createSqlStore(pgliteDb(pg)));
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  participants = (await import('../app/api/participants/route')) as unknown as typeof participants;
  exportRoute = (await import('../app/api/export/route')) as unknown as typeof exportRoute;
  status = (await import('../app/api/status/route')) as unknown as typeof status;
  image = (await import('../app/api/attachments/[id]/route')) as unknown as typeof image;
  pin = (await import('../app/api/messages/[id]/pin/route')) as unknown as typeof pin;
});
afterAll(async () => { await pg.close(); });

const URL_BASE = 'http://hub.test';
const auth = (who: string) => ({ Authorization: `Bearer ${TOKENS[who]}` });
const get = (path: string, who: string) => messages.GET(new Request(URL_BASE + path, { headers: auth(who) }));
const post = (body: unknown, who: string) => messages.POST(new Request(`${URL_BASE}/api/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: JSON.stringify(body),
}));

test('old settings on the old database: the three tokens work and the history is all there', async () => {
  const before = await contents(pg);
  const data = (await (await get('/api/messages', 'david')).json()) as { me: string; messages: Message[]; pinned: Message[] };
  assert.equal(data.me, 'david');
  assert.deepEqual(data.messages.map((m) => [m.id, m.sender, m.recipient]), [[1, 'hub', null], [2, 'david', null], [3, 'grok', 'claude'], [4, 'claude', 'david'], [5, 'david', 'grok']]);
  assert.equal(data.messages[0].text, 'the welcome text of that time', 'the welcome message it had is the one it keeps');
  assert.deepEqual(data.pinned.map((m) => m.id), [4]);
  assert.deepEqual(data.messages[4].attachments.map((a) => a.id), [IMAGE_ID]);
  assert.equal(await contents(pg), before, 'reading migrated the checks and touched no row');

  const picture = await image.GET(new Request(`${URL_BASE}/api/attachments/${IMAGE_ID}`, { headers: auth('claude') }), { params: Promise.resolve({ id: IMAGE_ID }) });
  assert.equal(picture.status, 200);
  assert.ok(Buffer.from(await picture.arrayBuffer()).equals(IMAGE_BYTES));

  const md = await (await exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth('grok') }))).text();
  assert.match(md, /\*\*Grok → Claude\*\* · 2026-11-25 11:02 · #3\n\n@claude please review/);
  assert.match(md, /- #4 \(Claude, 2026-11-25 11:03\): DECISION: we keep the three colours/);

  const { statuses } = (await (await status.GET(new Request(`${URL_BASE}/api/status`, { headers: auth('david') }))).json()) as { statuses: ParticipantStatus[] };
  assert.deepEqual(statuses.map((s) => s.participant), ['grok']);
});

test('old settings on the old database: posting, addressing, pinning and status go on as before', async () => {
  const a = await post({ text: '@claude still here after the update?' }, 'grok');
  assert.equal(a.status, 201);
  const sent = ((await a.json()) as { message: Message }).message;
  assert.deepEqual([sent.id, sent.sender, sent.recipient], [6, 'grok', 'claude']);
  const b = ((await (await post({ text: 'DECISION: yes', to: 'grok' }, 'david')).json()) as { message: Message }).message;
  assert.deepEqual([b.id, b.sender, b.recipient, Boolean(b.pinned_at)], [7, 'david', 'grok', true]);
  assert.equal((await post({ text: 'x', to: 'mallory' }, 'grok')).status, 400);
  assert.equal((await messages.GET(new Request(`${URL_BASE}/api/messages`, { headers: { Authorization: 'Bearer wrong-token-0123456789' } }))).status, 401);

  const since = (await (await get('/api/messages?since=5&to=claude', 'claude')).json()) as { me: string; messages: Message[] };
  assert.equal(since.me, 'claude');
  assert.deepEqual(since.messages.map((m) => m.id), [6]);
  const unpin = await pin.POST(new Request(`${URL_BASE}/api/messages/4/pin`, { method: 'POST', headers: auth('grok'), body: '{"pinned":false}' }), { params: Promise.resolve({ id: '4' }) });
  assert.deepEqual(((await unpin.json()) as { pinned: Message[] }).pinned.map((m) => m.id), [7]);
  const put = await status.PUT(new Request(`${URL_BASE}/api/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth('claude') }, body: '{"text":"checking the update"}' }));
  assert.equal(put.status, 200);
});

test('old settings: the page is told the three participants, with the colours they always had', async () => {
  const res = await participants.GET(new Request(`${URL_BASE}/api/participants`, { headers: auth('david') }));
  assert.deepEqual(await res.json(), {
    me: 'david',
    participants: [
      { name: 'grok', kind: 'agent', color: 0, label: 'Grok', wake_target_host: null, wake_target_set_at: null },
      { name: 'claude', kind: 'agent', color: 1, label: 'Claude', wake_target_host: null, wake_target_set_at: null },
      { name: 'david', kind: 'human', color: 2, label: 'David', wake_target_host: null, wake_target_set_at: null },
    ],
  });
});
