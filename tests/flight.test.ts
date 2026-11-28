// Work in flight: input parsing, both stores (memory and PGlite) and the API route.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { FLIGHT_TEXT_MAX_LENGTH, parseFlightInput, type Flight } from '../lib/core';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';

const TOKENS: Record<string, string> = {
  grok: 'grok-flight-token-0123456789abcdef',
  claude: 'claude-flight-token-0123456789abcd',
  david: 'david-flight-token-0123456789abcdef',
};

type Handler = (request: Request) => Promise<Response>;
let route: { GET: Handler; PUT: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  route = (await import('../app/api/flight/route')) as unknown as typeof route;
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

test('parseFlightInput: working and waiting need a text, idle has none', () => {
  assert.deepEqual(parseFlightInput({ state: 'working', text: '  Journal\n01 ' }), { ok: true, state: 'working', text: 'Journal 01' });
  assert.deepEqual(parseFlightInput({ state: 'waiting', text: 'review of PR 62' }), { ok: true, state: 'waiting', text: 'review of PR 62' });
  assert.deepEqual(parseFlightInput({ state: 'idle', text: 'ignored' }), { ok: true, state: 'idle', text: '' });
  assert.deepEqual(parseFlightInput({ state: 'working', text: 'x'.repeat(FLIGHT_TEXT_MAX_LENGTH) }).ok, true);
  for (const bad of [null, [], {}, { state: 'busy', text: 'x' }, { state: 'working' }, { state: 'working', text: '  ' },
    { state: 'waiting', text: 'x'.repeat(FLIGHT_TEXT_MAX_LENGTH + 1) }, { state: 'working', text: 'ok\u0000' }, { state: 'working', text: 7 }]) {
    assert.equal(parseFlightInput(bad).ok, false, JSON.stringify(bad));
  }
});

async function sinceKeepsUntilAChange(store: Store, tick: () => Promise<void>) {
  assert.deepEqual(await store.listFlights(), []);
  const first = await store.setFlight({ participant: 'claude', state: 'working', text: 'Journal 01' });
  assert.equal(first.state, 'working');
  await tick();
  const again = await store.setFlight({ participant: 'claude', state: 'working', text: 'Journal 01' });
  assert.equal(again.since, first.since, 'the same again keeps the clock');
  assert.ok(again.updated_at >= first.updated_at);
  await tick();
  const other = await store.setFlight({ participant: 'claude', state: 'working', text: 'work in flight' });
  assert.notEqual(other.since, first.since, 'a new text restarts it');
  await tick();
  const waiting = await store.setFlight({ participant: 'claude', state: 'waiting', text: 'work in flight' });
  assert.notEqual(waiting.since, other.since, 'a new state restarts it');
  await store.setFlight({ participant: 'grok', state: 'idle', text: '' });
  const list = await store.listFlights();
  assert.deepEqual(list.map((f) => [f.participant, f.state, f.text]), [['claude', 'waiting', 'work in flight'], ['grok', 'idle', '']]);
}

test('memory store: since stays until the state or text changes; last_message_at follows the messages', async () => {
  let nowMs = Date.parse('2026-11-27T07:30:00.000Z');
  const store = createMemoryStore({ now: () => nowMs });
  await sinceKeepsUntilAChange(store, async () => { nowMs += 60_000; });
  assert.equal((await store.listFlights()).find((f) => f.participant === 'claude')!.last_message_at, null);
  await store.add({ sender: 'claude', recipient: null, text: 'hello' });
  const claude = (await store.listFlights()).find((f) => f.participant === 'claude')!;
  assert.ok(claude.last_message_at, 'a message counts');
  nowMs += 25 * 3_600_000;
  assert.equal((await store.listFlights()).find((f) => f.participant === 'claude')!.last_message_at, null, 'older than a day does not');
});

test('sql (PGlite): the same rules, and the table refuses what is not a flight', async () => {
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  await sinceKeepsUntilAChange(store, () => new Promise((r) => setTimeout(r, 15)));
  await store.add({ sender: 'grok', recipient: null, text: 'hi' });
  const grok = (await store.listFlights()).find((f) => f.participant === 'grok')!;
  assert.ok(grok.last_message_at);
  await assert.rejects(store.setFlight({ participant: 'Not A Name', state: 'idle', text: '' }));
  await assert.rejects(store.setFlight({ participant: 'grok', state: 'busy' as 'idle', text: '' }));
  await assert.rejects(store.setFlight({ participant: 'grok', state: 'working', text: '' }));
  await assert.rejects(store.setFlight({ participant: 'grok', state: 'working', text: 'x'.repeat(81) }));
  assert.ok(await store.setFlight({ participant: 'quill-2', state: 'working', text: 'a fourth participant' }));
});

const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const put = (who: string | undefined, body: unknown) => route.PUT(new Request('http://hub.test/api/flight', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));

test('API /api/flight: a token is needed, a flight is the caller\'s own, bad input is a 400', async () => {
  for (const who of [undefined, 'wrong-token-0123456789abcdef']) {
    assert.equal((await route.GET(new Request('http://hub.test/api/flight', { headers: auth(who) }))).status, 401);
    assert.equal((await put(who, { state: 'idle' })).status, 401);
  }
  const res = await put('grok', { state: 'working', text: 'Ship it button', participant: 'david' });
  assert.equal(res.status, 200);
  const { flight } = (await res.json()) as { flight: Flight };
  assert.equal(flight.participant, 'grok');
  assert.equal(flight.text, 'Ship it button');
  assert.equal((await put('grok', { state: 'working' })).status, 400);
  assert.equal((await put('grok', 'not-json')).status, 400);
  assert.equal((await put('grok', { state: 'idle', pad: 'y'.repeat(5000) })).status, 413);
  const all = (await (await route.GET(new Request('http://hub.test/api/flight', { headers: auth('david') }))).json()) as { flights: Flight[] };
  assert.deepEqual(all.flights.map((f) => f.participant), ['grok']);
});
