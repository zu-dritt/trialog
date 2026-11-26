// Read positions: parsing, both stores, the opt-in list, markRead, only-forward, and the stream event.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { parseReadInput, type Message } from '../lib/core';
import {
  UNSEEN_AFTER_MS, UNSEEN_LABEL, addressedAgents, applyReads, unseenByAgents,
  type Participant, type ReadPosition,
} from '../lib/shared';
import { ReadError, createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { createEventStream, readParticipantsChanged } from '../lib/stream';
import { createSseParser, type SseEvent } from '../lib/sse';

const TOKENS: Record<string, string> = {
  grok: 'grok-reads-token-0123456789abcdef',
  claude: 'claude-reads-token-0123456789abcd',
  david: 'david-reads-token-0123456789abcdef',
};

type Handler = (request: Request) => Promise<Response>;
let readRoute: { PUT: Handler };
let messagesRoute: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  readRoute = (await import('../app/api/read/route')) as unknown as typeof readRoute;
  messagesRoute = (await import('../app/api/messages/route')) as unknown as typeof messagesRoute;
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

const must = <T>(v: T | null | undefined): T => { assert.ok(v); return v; };
const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const THREE: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0 },
  { name: 'claude', kind: 'agent', color: 1 },
  { name: 'david', kind: 'human', color: 2 },
];

test('parseReadInput accepts a positive message id and refuses anything else', () => {
  assert.deepEqual(parseReadInput({ upTo: 45 }), { ok: true, upTo: 45 });
  assert.deepEqual(parseReadInput({ upTo: '45' }), { ok: true, upTo: 45 });
  assert.equal(parseReadInput({ upTo: 0 }).ok, false);
  assert.equal(parseReadInput({ upTo: -1 }).ok, false);
  assert.equal(parseReadInput({ upTo: 1.5 }).ok, false);
  assert.equal(parseReadInput({ upTo: 'no' }).ok, false);
  assert.equal(parseReadInput({}).ok, false);
  assert.equal(parseReadInput(null).ok, false);
});

test('addressedAgents and unseenByAgents follow the recipients and the two-minute line', () => {
  const now = Date.parse('2026-11-26T09:00:00.000Z');
  const old = new Date(now - UNSEEN_AFTER_MS - 1_000).toISOString();
  const fresh = new Date(now - 1_000).toISOString();
  const toEveryone = { id: 10, sender: 'david', recipient: null, created_at: old };
  const toGrok = { id: 11, sender: 'david', recipient: 'grok', created_at: old };
  const toHuman = { id: 12, sender: 'grok', recipient: 'david', created_at: old };
  const fromHub = { id: 1, sender: 'hub', recipient: null, created_at: old };
  const tooNew = { id: 13, sender: 'david', recipient: 'grok', created_at: fresh };

  assert.deepEqual(addressedAgents(toEveryone, THREE), ['grok', 'claude']);
  assert.deepEqual(addressedAgents(toGrok, THREE), ['grok']);
  assert.deepEqual(addressedAgents(toHuman, THREE), []);
  assert.deepEqual(addressedAgents(fromHub, THREE), []);
  assert.deepEqual(addressedAgents({ sender: 'grok', recipient: null }, THREE), ['claude']);

  assert.equal(unseenByAgents(toGrok, [], THREE, now), true);
  assert.equal(unseenByAgents(tooNew, [], THREE, now), false);
  assert.equal(unseenByAgents(toHuman, [], THREE, now), false);
  assert.equal(unseenByAgents(fromHub, [], THREE, now), false);
  assert.equal(unseenByAgents(toGrok, [{ participant: 'grok', up_to: 11, updated_at: old }], THREE, now), false);
  assert.equal(unseenByAgents(toGrok, [{ participant: 'grok', up_to: 10, updated_at: old }], THREE, now), true);
  assert.equal(unseenByAgents(toEveryone, [{ participant: 'grok', up_to: 20, updated_at: old }], THREE, now), false, 'the flag goes once any addressed agent has read past it');
  assert.equal(unseenByAgents(toEveryone, [
    { participant: 'grok', up_to: 20, updated_at: old },
    { participant: 'claude', up_to: 20, updated_at: old },
  ], THREE, now), false);
  assert.equal(UNSEEN_LABEL, '⏰ not seen yet');
});

test('applyReads merges and never moves a position backwards', () => {
  const a: ReadPosition = { participant: 'grok', up_to: 4, updated_at: '2026-11-26T09:00:00.000Z' };
  const b: ReadPosition = { participant: 'claude', up_to: 7, updated_at: '2026-11-26T09:01:00.000Z' };
  const later: ReadPosition = { participant: 'grok', up_to: 9, updated_at: '2026-11-26T09:02:00.000Z' };
  const earlier: ReadPosition = { participant: 'grok', up_to: 3, updated_at: '2026-11-26T09:03:00.000Z' };
  const merged = applyReads([a], [b, later, earlier]);
  assert.deepEqual(merged.map((r) => [r.participant, r.up_to]), [['claude', 7], ['grok', 9]]);
});

test('readParticipantsChanged lists only the names whose position moved', () => {
  assert.deepEqual(readParticipantsChanged('0|', '2|claude:7,grok:4'), ['claude', 'grok']);
  assert.deepEqual(readParticipantsChanged('2|claude:7,grok:4', '2|claude:7,grok:9'), ['grok']);
  assert.deepEqual(readParticipantsChanged('2|claude:7,grok:9', '2|claude:7,grok:9'), []);
});

const stores = () => [
  ['sql (PGlite)', async (): Promise<Store> => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async (): Promise<Store> => createMemoryStore()],
] as const;

for (const [name, make] of stores()) {
  test(`${name}: a read position only moves forward, and a missing message is refused`, async () => {
    const store = await make();
    const first = must(await store.add({ sender: 'david', recipient: null, text: 'one' }));
    const second = must(await store.add({ sender: 'david', recipient: null, text: 'two' }));
    const a = await store.setReadPosition('claude', first.id);
    assert.equal(a.participant, 'claude');
    assert.equal(a.up_to, first.id);
    const back = await store.setReadPosition('claude', first.id);
    assert.equal(back.up_to, first.id);
    const stay = await store.setReadPosition('claude', first.id - 1 < 1 ? first.id : 1);
    // 1 is the welcome, which exists; if first.id is 2, moving to 1 must stay at first.id
    assert.equal(stay.up_to, first.id);
    const fwd = await store.setReadPosition('claude', second.id);
    assert.equal(fwd.up_to, second.id);
    await assert.rejects(store.setReadPosition('claude', 99_999), ReadError);
    const listed = await store.listReads();
    assert.deepEqual(listed.map((r) => [r.participant, r.up_to]), [['claude', second.id]]);
    const version = await store.version();
    assert.match(version.reads, /claude:/);
  });

  test(`${name}: the stream sends the full list at the start and only the position that moved later`, async () => {
    const store = await make();
    const first = must(await store.add({ sender: 'david', recipient: null, text: 'one' }));
    await store.setReadPosition('grok', first.id);
    const abort = new AbortController();
    const events: { event: string; data: unknown }[] = [];
    const stream = createEventStream({ store, me: 'claude', since: null, signal: abort.signal, intervalMs: 20, heartbeatMs: 10_000, maxMs: 5_000 });
    const parser = createSseParser((e: SseEvent) => events.push({ event: e.event, data: e.data }));
    const reader = stream.getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(Buffer.from(value).toString('utf8'));
      }
    })();
    await new Promise((r) => setTimeout(r, 60));
    const opening = events.filter((e) => e.event === 'reads');
    assert.equal(opening.length, 1);
    const initial = JSON.parse(opening[0].data as string) as ReadPosition[];
    assert.deepEqual(initial.map((r) => [r.participant, r.up_to]), [['grok', first.id]]);

    const second = must(await store.add({ sender: 'david', recipient: null, text: 'two' }));
    await store.setReadPosition('claude', second.id);
    await new Promise((r) => setTimeout(r, 80));
    const later = events.filter((e) => e.event === 'reads').slice(1);
    assert.ok(later.length >= 1, JSON.stringify(events));
    const moved = later.flatMap((e) => JSON.parse(e.data as string) as ReadPosition[]);
    assert.ok(moved.some((r) => r.participant === 'claude' && r.up_to === second.id), JSON.stringify(moved));
    assert.ok(!moved.some((r) => r.participant === 'grok'), 'an unchanged position is not re-sent');
    abort.abort();
    await pump;
  });
}

test('the API takes the participant from the token, ignores a lower id, and lists positions only when asked', async () => {
  const req = (path: string, init: RequestInit = {}) => new Request(`http://hub.test${path}`, init);
  const posted = await messagesRoute.GET(req('/api/messages?limit=5', { headers: auth('david') }));
  assert.equal(posted.status, 200);
  const body = await posted.json() as { messages: Message[]; reads?: ReadPosition[] };
  assert.equal(body.reads, undefined, 'the list is omitted without ?reads=1');
  const last = body.messages[body.messages.length - 1].id;

  const put = await readRoute.PUT(req('/api/read', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('claude') },
    body: JSON.stringify({ upTo: last, participant: 'david' }),
  }));
  assert.equal(put.status, 200);
  const recorded = await put.json() as { read: ReadPosition };
  assert.equal(recorded.read.participant, 'claude');
  assert.equal(recorded.read.up_to, last);

  const back = await readRoute.PUT(req('/api/read', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('claude') },
    body: JSON.stringify({ upTo: 1 }),
  }));
  assert.equal(back.status, 200);
  assert.equal(((await back.json()) as { read: ReadPosition }).read.up_to, last);

  const missing = await readRoute.PUT(req('/api/read', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('claude') },
    body: JSON.stringify({ upTo: 99_999 }),
  }));
  assert.equal(missing.status, 404);

  const listed = await messagesRoute.GET(req('/api/messages?reads=1&limit=5', { headers: auth('david') }));
  const withReads = await listed.json() as { reads: ReadPosition[] };
  assert.ok(withReads.reads.some((r) => r.participant === 'claude' && r.up_to === last));

  const marked = await messagesRoute.GET(req('/api/messages?markRead=1&reads=1&limit=5', { headers: auth('grok') }));
  const afterMark = await marked.json() as { reads: ReadPosition[]; messages: Message[] };
  const high = afterMark.messages[afterMark.messages.length - 1].id;
  assert.ok(afterMark.reads.some((r) => r.participant === 'grok' && r.up_to === high));
});
