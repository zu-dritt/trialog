// Replies: a message can name the earlier message it answers. The store contract runs on the real
// SQL (PGlite) and on the memory store; the API is called through the real route handlers.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { parseMessageInput, parseReplyTo, toMarkdown, type Message } from '../lib/core';
import { createSseParser, type SseEvent } from '../lib/sse';
import { ReplyTargetError, createMemoryStore, createSqlStore, wakesGrok, type Db, type Row, type Store } from '../lib/store';
import { createEventStream } from '../lib/stream';

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];
const must = <T>(v: T | null | undefined): T => { assert.ok(v, 'expected a value'); return v; };

// --- reading the request ------------------------------------------------------------------------

// The names that apply when PARTICIPANTS is not set.
const THREE = ['grok', 'claude', 'david'];

test('parseReplyTo: a message id, nothing, or not an id', () => {
  assert.equal(parseReplyTo(undefined), null);
  assert.equal(parseReplyTo(null), null);
  assert.equal(parseReplyTo(45), 45);
  assert.equal(parseReplyTo('45'), 45, 'a number sent as text is accepted');
  for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 60, '', ' 45', '4 5', '45abc', '-3', '0x10', true, [45], { id: 45 }]) {
    assert.equal(parseReplyTo(bad), undefined, JSON.stringify(bad));
  }
});

test('parseMessageInput: reply_to is optional and never changes addressing or pinning', () => {
  const ok = (body: unknown) => { const r = parseMessageInput(body, THREE); assert.ok(r.ok, JSON.stringify(r)); return r; };
  assert.equal(ok({ text: 'plain' }).replyTo, null);
  assert.equal(ok({ text: 'answer', reply_to: 45 }).replyTo, 45);
  assert.equal(ok({ text: 'answer', reply_to: null }).replyTo, null);
  const r = ok({ text: '@grok DECISION: yes', reply_to: 7 });
  assert.deepEqual([r.recipient, r.pinned, r.replyTo], ['grok', true, 7]);
  // A reply to someone is not addressed to them by itself: the sender says who it is for.
  assert.equal(ok({ text: 'answer', reply_to: 7 }).recipient, null);
  const bad = parseMessageInput({ text: 'answer', reply_to: 'the last one' }, THREE);
  assert.ok(!bad.ok && bad.status === 400 && /reply_to/.test(bad.error));
  // Text is still required: a reply with nothing in it is not a message.
  assert.equal(parseMessageInput({ text: '', reply_to: 45 }, THREE).ok, false);
});

// --- the store ----------------------------------------------------------------------------------

for (const [name, make] of STORES) {
  test(`${name}: a reply is stored with the message it answers, and comes back everywhere`, async () => {
    const store = await make();
    const first = must(await store.add({ sender: 'grok', recipient: null, text: 'a question' }));
    const reply = must(await store.add({ sender: 'claude', recipient: 'grok', text: 'DECISION: an answer', pinned: true, reply_to: first.id }));
    const again = must(await store.add({ sender: 'david', recipient: null, text: 'an answer to the answer', reply_to: reply.id }));
    assert.equal(first.reply_to, null);
    assert.equal(reply.reply_to, first.id);
    assert.equal(again.reply_to, reply.id, 'a reply can itself be answered');
    assert.ok(first.id < reply.id && reply.id < again.id, 'ids still grow in order');

    const expect = (list: Message[], where: string) => {
      const byId = new Map(list.map((m) => [m.id, m.reply_to]));
      if (byId.has(first.id)) assert.equal(byId.get(first.id), null, where);
      if (byId.has(reply.id)) assert.equal(byId.get(reply.id), first.id, where);
      if (byId.has(again.id)) assert.equal(byId.get(again.id), reply.id, where);
      assert.ok(list.every((m) => m.reply_to === null || typeof m.reply_to === 'number'), `${where}: the field is always there`);
    };
    expect(await store.list(), 'list (latest)');
    expect(await store.list({ since: 0 }), 'list (since)');
    expect(await store.list({ since: 0, to: 'grok' }), 'list (to)');
    expect(await store.all(), 'all');
    expect(await store.pinned(), 'pinned');
    assert.equal(must(await store.setPinned(reply.id, false)).reply_to, first.id, 'setPinned');

    // The live stream sends the same message objects.
    const events: SseEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    const reader = createEventStream({ store, me: 'david', since: first.id, intervalMs: 5, maxMs: 20 }).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    const streamed = JSON.parse(must(events.find((e) => e.event === 'messages')).data) as Message[];
    assert.deepEqual(streamed.map((m) => [m.id, m.reply_to]), [[reply.id, first.id], [again.id, reply.id]]);
  });

  test(`${name}: a reply to a message that does not exist is refused, and nothing is stored`, async () => {
    const store = await make();
    const count = (await store.all()).length;
    await assert.rejects(
      store.add({ sender: 'grok', recipient: null, text: 'to nobody', reply_to: 999_999 }),
      (e: unknown) => e instanceof ReplyTargetError && e.messageId === 999_999 && /#999999 does not exist/.test(e.message),
    );
    assert.equal((await store.all()).length, count);
    // The welcome message, written by the hub, can be answered like any other.
    const welcome = (await store.all())[0];
    assert.equal(must(await store.add({ sender: 'grok', recipient: null, text: 'hello back', reply_to: welcome.id })).reply_to, welcome.id);
    // No reply_to, or null, is a plain message, as before.
    assert.equal(must(await store.add({ sender: 'grok', recipient: null, text: 'plain' })).reply_to, null);
    assert.equal(must(await store.add({ sender: 'grok', recipient: null, text: 'plain', reply_to: null })).reply_to, null);
  });

  test(`${name}: replying changes neither who is woken nor the rate limit`, async () => {
    const store = await make();
    const fromGrok = must(await store.add({ sender: 'grok', recipient: null, text: 'grok asks' }));
    // The wake-up rule looks at sender and recipient only. A reply to Grok's message that is
    // addressed to Claude does not wake Grok; one addressed to everyone does, reply or not.
    const toClaude = must(await store.add({ sender: 'david', recipient: 'claude', text: 'for claude', reply_to: fromGrok.id }));
    const toAll = must(await store.add({ sender: 'david', recipient: null, text: 'for all', reply_to: fromGrok.id }));
    assert.equal(wakesGrok(toClaude), false);
    assert.equal(wakesGrok(toAll), true);
    assert.deepEqual(await store.claimWakeup(), { first_id: toAll.id, last_id: toAll.id, count: 1, previous_id: 0 });
    // Replies count towards the sender's posts per minute like any message.
    for (let i = 0; i < 2; i++) assert.ok(await store.add({ sender: 'claude', recipient: null, text: `r${i}`, reply_to: fromGrok.id }, 2));
    assert.equal(await store.add({ sender: 'claude', recipient: null, text: 'one too many', reply_to: fromGrok.id }, 2), null);
  });

  test(`${name}: ids stay in commit order when replies and plain messages are posted together`, async () => {
    const store = await make();
    const root = must(await store.add({ sender: 'david', recipient: null, text: 'root' }));
    const posted = await Promise.all([
      store.add({ sender: 'grok', recipient: null, text: 'a', reply_to: root.id }),
      store.add({ sender: 'claude', recipient: null, text: 'b' }),
      store.add({ sender: 'david', recipient: null, text: 'c', reply_to: root.id }),
      store.add({ sender: 'grok', recipient: null, text: 'd' }),
    ]);
    const ids = posted.map((m) => must(m).id);
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
    assert.deepEqual((await store.list({ since: root.id })).map((m) => [m.id, m.reply_to]), [[ids[0], root.id], [ids[1], null], [ids[2], root.id], [ids[3], null]]);
  });
}

test('sql: a database from before replies gains the column on first request and keeps its history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trialog-'));
  try {
    // The schema as it was before this change: everything before the replies migration.
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    const old = schema.slice(0, schema.indexOf('DO $$'));
    assert.ok(old.includes('participant_status') && !old.includes('reply_to'));
    const db1 = new PGlite(dir);
    await db1.exec(old);
    await db1.query(`INSERT INTO messages (sender, text) VALUES ('hub', 'welcome'), ('david', 'from before')`, []);
    await db1.close();

    const db2 = new PGlite(dir);
    const store = createSqlStore(pgliteDb(db2));
    assert.deepEqual((await store.all()).map((m) => [m.text, m.reply_to]), [['welcome', null], ['from before', null]]);
    const old2 = (await store.all())[1];
    const reply = must(await store.add({ sender: 'grok', recipient: null, text: 'an answer to an old message', reply_to: old2.id }));
    await db2.close();

    // Running the schema again changes nothing: the column is added once.
    const db3 = new PGlite(dir);
    const again = createSqlStore(pgliteDb(db3));
    await again.ensure();
    await again.ensure();
    assert.deepEqual((await again.all()).map((m) => m.reply_to), [null, null, old2.id]);
    const columns = await db3.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'reply_to'`, []);
    assert.equal((columns.rows[0] as { n: number }).n, 1);
    // The database itself refuses a reply to nothing, whoever writes to it.
    await assert.rejects(db3.query(`INSERT INTO messages (sender, text, reply_to) VALUES ('grok', 'x', 424242)`, []), /foreign key/i);
    // Should a message ever be removed by hand, its answers stay and simply stop pointing at it.
    await db3.query(`DELETE FROM messages WHERE id = $1`, [old2.id]);
    assert.equal(must((await again.all()).find((m) => m.id === reply.id)).reply_to, null);
    await db3.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the export ---------------------------------------------------------------------------------

test('the export names the message a reply answers', () => {
  const base: Pick<Message, 'recipient' | 'created_at' | 'room' | 'attachments' | 'poll' | 'reactions'> = { recipient: null, created_at: '2026-11-25T13:00:00Z', room: 'main', attachments: [], poll: null, reactions: [] };
  const messages: Message[] = [
    { ...base, id: 45, sender: 'grok', text: 'a question', pinned_at: null, reply_to: null },
    { ...base, id: 46, sender: 'claude', recipient: 'grok', text: 'DECISION: an answer', pinned_at: '2026-11-25T13:01:00Z', reply_to: 45 },
  ];
  const md = toMarkdown(messages, new Date('2026-11-25T14:00:00Z'));
  assert.ok(md.includes('**Grok** · 2026-11-25 14:00 · #45\n\na question'), 'a plain message has no arrow');
  assert.ok(md.includes('**Claude → Grok** · 2026-11-25 14:00 · #46 · ↳ #45 · 📌\n\nDECISION: an answer'), md);
});

// --- the API ------------------------------------------------------------------------------------

const TOKENS: Record<string, string> = {
  grok: 'grok-test-token-0123456789abcdef',
  claude: 'claude-test-token-0123456789abcdef',
  david: 'david-test-token-0123456789abcdef',
};
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let messages: { GET: Handler; POST: Handler };
let exportRoute: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  exportRoute = (await import('../app/api/export/route')) as unknown as typeof exportRoute;
});

const URL_BASE = 'http://hub.test';
const auth = (who: string) => ({ Authorization: `Bearer ${TOKENS[who]}` });
const post = (body: unknown, who: string) => messages.POST(new Request(`${URL_BASE}/api/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: JSON.stringify(body),
}));
const posted = async (body: unknown, who: string) => ((await (await post(body, who)).json()) as { message: Message }).message;
const list = async (query = '?since=0') => ((await (await messages.GET(new Request(`${URL_BASE}/api/messages${query}`, { headers: auth('david') }))).json()) as { messages: Message[]; pinned: Message[] });

test('POST /api/messages takes reply_to, and every answer carries it', async () => {
  const question = await posted({ text: 'which storage?' }, 'grok');
  const res = await post({ text: 'DECISION: the database', reply_to: question.id }, 'claude');
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.equal(message.reply_to, question.id);
  assert.equal(message.sender, 'claude', 'the sender still comes from the token');

  const all = await list();
  assert.equal(all.messages.find((m) => m.id === message.id)?.reply_to, question.id);
  assert.equal(all.messages.find((m) => m.id === question.id)?.reply_to, null);
  assert.equal(all.pinned.find((m) => m.id === message.id)?.reply_to, question.id);
  assert.ok(all.messages.every((m) => 'reply_to' in m), 'every message has the field');
  assert.deepEqual((await list(`?since=${question.id}`)).messages.map((m) => m.reply_to), [question.id]);

  const md = await (await exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth('david') }))).text();
  assert.ok(md.includes(`· #${message.id} · ↳ #${question.id} · 📌`), md);
});

test('a reply to a message that does not exist, or a reply_to that is no id, is refused', async () => {
  const before = (await list()).messages.length;
  const missing = await post({ text: 'to nobody', reply_to: 999_999 }, 'grok');
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: string }).error, /#999999 does not exist/);
  for (const bad of ['latest', 0, -1, 1.5, [1], { id: 1 }, true]) {
    const res = await post({ text: 'x', reply_to: bad }, 'grok');
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(((await res.json()) as { error: string }).error, /reply_to/);
  }
  assert.equal((await list()).messages.length, before, 'none of them was stored');
});

test('old clients that send no reply_to work unchanged', async () => {
  const res = await post({ text: 'plain, as before' }, 'david');
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.equal(message.reply_to, null);
  assert.deepEqual(Object.keys(message).sort(), ['attachments', 'created_at', 'decision', 'id', 'pin_title', 'pinned_at', 'poll', 'reactions', 'recipient', 'reply_to', 'room', 'sender', 'text']);
  assert.equal((await post({ text: 'null is fine too', reply_to: null }, 'david')).status, 201);
  // A "sender" in the body is still ignored, also on a reply.
  const spoof = await posted({ text: 'I am not Grok', sender: 'grok', reply_to: message.id }, 'claude');
  assert.equal(spoof.sender, 'claude');
});
