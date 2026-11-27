// The roadmap: input rules, both stores (memory and PGlite) and the API.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { parseItemChange, parseNewItem, parseOrder, type RoadmapItem } from '../lib/roadmap';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';

const NAMES = ['david', 'claude', 'grok'];

test('a new card needs a column and a title; note and owner are optional, and the owner must be a participant', () => {
  assert.deepEqual(parseNewItem({ column: 'next', title: '  Deploy\nbutton ' }, NAMES), { ok: true, column: 'next', title: 'Deploy button', note: '', owner: null });
  assert.deepEqual(parseNewItem({ column: 'now', title: 'x', note: 'y', owner: 'grok' }, NAMES), { ok: true, column: 'now', title: 'x', note: 'y', owner: 'grok' });
  for (const bad of [null, {}, { column: 'soon', title: 'x' }, { column: 'next' }, { column: 'next', title: '' }, { column: 'next', title: 'x'.repeat(81) },
    { column: 'next', title: 'x', note: 'n'.repeat(121) }, { column: 'next', title: 'x', owner: 'ana' }]) {
    assert.equal(parseNewItem(bad, NAMES).ok, false, JSON.stringify(bad));
  }
});

test('a change needs something to change; an order needs every id once', () => {
  assert.deepEqual(parseItemChange({ column: 'done' }, NAMES), { ok: true, change: { column: 'done' } });
  assert.deepEqual(parseItemChange({ owner: null }, NAMES), { ok: true, change: { owner: null } });
  assert.equal(parseItemChange({}, NAMES).ok, false);
  assert.deepEqual(parseOrder({ column: 'next', ids: ['rm_aaaaaaaa', 'rm_bbbbbbbb'] }), { ok: true, column: 'next', ids: ['rm_aaaaaaaa', 'rm_bbbbbbbb'] });
  for (const bad of [{ column: 'next', ids: ['rm_aaaaaaaa', 'rm_aaaaaaaa'] }, { column: 'next', ids: ['nope'] }, { column: 'x', ids: [] }, { column: 'next' }]) {
    assert.equal(parseOrder(bad).ok, false, JSON.stringify(bad));
  }
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

async function sameRules(store: Store) {
  const a = (await store.addRoadmapItem({ column: 'next', title: 'A', note: '', owner: 'claude', by: 'claude' }))!;
  const b = (await store.addRoadmapItem({ column: 'next', title: 'B', note: 'n', owner: null, by: 'grok' }))!;
  const c = (await store.addRoadmapItem({ column: 'next', title: 'C', note: '', owner: 'grok', by: 'grok' }))!;
  await store.addRoadmapItem({ column: 'done', title: 'D', note: '', owner: null, by: 'david' });
  const titles = async () => (await store.listRoadmap()).map((i) => `${i.column}:${i.title}`);
  assert.deepEqual(await titles(), ['done:D', 'next:A', 'next:B', 'next:C'], 'by column, then in the order added');
  const order = await store.reorderRoadmap('next', [c.id, a.id, b.id], 'david');
  assert.deepEqual(order?.map((i) => i.title), ['C', 'A', 'B']);
  assert.equal(order?.find((i) => i.id === c.id)?.updated_by, 'david');
  assert.equal(await store.reorderRoadmap('next', [c.id, a.id], 'david'), null, 'a missing card refuses the whole order');
  assert.deepEqual(await titles(), ['done:D', 'next:C', 'next:A', 'next:B'], 'and nothing changed');
  const moved = await store.updateRoadmapItem(a.id, { column: 'done', note: 'shipped' }, 'claude');
  assert.equal(moved?.column, 'done');
  assert.equal(moved?.note, 'shipped');
  assert.deepEqual(await titles(), ['done:D', 'done:A', 'next:C', 'next:B'], 'a new column puts the card at its end');
  assert.equal(await store.updateRoadmapItem('rm_00000000', { title: 'x' }, 'claude'), null);
  assert.equal(await store.deleteRoadmapItem(b.id), true);
  assert.equal(await store.deleteRoadmapItem(b.id), false);
}

test('memory store: add, order, move, remove', async () => { await sameRules(createMemoryStore()); });

test('sql (PGlite): the same, and the table refuses what is not a card', async () => {
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  await sameRules(store);
  await assert.rejects(store.addRoadmapItem({ column: 'next', title: '', note: '', owner: null, by: 'claude' }));
  await assert.rejects(store.addRoadmapItem({ column: 'soon' as 'next', title: 'x', note: '', owner: null, by: 'claude' }));
  await assert.rejects(store.addRoadmapItem({ column: 'next', title: 'x', note: '', owner: 'Not A Name', by: 'claude' }));
});

const TOKENS: Record<string, string> = { david: 'david-roadmap-token-0123456789abcdef', claude: 'claude-roadmap-token-0123456789abcd', grok: 'grok-roadmap-token-0123456789abcdef' };
type Handler = (request: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
let list: { GET: Handler; POST: Handler; PUT: Handler };
let one: { PATCH: Handler; DELETE: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.DAVID_TOKEN = TOKENS.david;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.GROK_TOKEN = TOKENS.grok;
  console.warn = () => {};
  list = (await import('../app/api/roadmap/route')) as unknown as typeof list;
  one = (await import('../app/api/roadmap/[id]/route')) as unknown as typeof one;
});

const req = (who: string | undefined, method: string, body?: unknown, path = '/api/roadmap') => new Request(`http://hub.test${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});

test('API: a token is needed; add, reorder with a fresh list only, move, remove', async () => {
  assert.equal((await list.GET(req(undefined, 'GET'))).status, 401);
  const r1 = await list.POST(req('claude', 'POST', { column: 'next', title: 'Hovercard', owner: 'claude' }));
  assert.equal(r1.status, 201);
  const a = ((await r1.json()) as { item: RoadmapItem }).item;
  const b = ((await (await list.POST(req('grok', 'POST', { column: 'next', title: 'Deploy button' }))).json()) as { item: RoadmapItem }).item;
  assert.equal(b.updated_by, 'grok', 'who comes from the token');
  assert.equal((await list.POST(req('grok', 'POST', { column: 'next', title: 'x', owner: 'ana' }))).status, 400);
  assert.equal((await list.PUT(req('david', 'PUT', { column: 'next', ids: [b.id, a.id] }))).status, 200);
  assert.equal((await list.PUT(req('david', 'PUT', { column: 'next', ids: [b.id] }))).status, 409, 'a stale list is refused');
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const moved = await one.PATCH(req('claude', 'PATCH', { column: 'done' }, `/api/roadmap/${a.id}`), ctx(a.id));
  assert.equal(((await moved.json()) as { item: RoadmapItem }).item.column, 'done');
  assert.equal((await one.PATCH(req('claude', 'PATCH', { column: 'done' }, '/api/roadmap/nope'), ctx('nope'))).status, 404);
  assert.equal((await one.DELETE(req('claude', 'DELETE', undefined, `/api/roadmap/${b.id}`), ctx(b.id))).status, 200);
  const { items } = (await (await list.GET(req('david', 'GET'))).json()) as { items: RoadmapItem[] };
  assert.deepEqual(items.map((i) => [i.column, i.title]), [['done', 'Hovercard']]);
});

async function claimRules(store: Store) {
  const card = (await store.addRoadmapItem({ column: 'next', title: 'Chime', note: '', owner: null, by: 'david' }))!;
  // Two claims at the same moment: exactly one wins.
  const [a, b] = await Promise.all([store.claimRoadmapItem(card.id, 'claude', 'exists, small fix'), store.claimRoadmapItem(card.id, 'grok', 'new')]);
  const winners = [a, b].filter((r) => r.status === 'ok');
  assert.equal(winners.length, 1, 'one claim wins');
  const loser = [a, b].find((r) => r.status === 'taken');
  assert.ok(loser && loser.status === 'taken');
  const owner = winners[0].status === 'ok' ? winners[0].item.owner : '';
  assert.equal(loser.owner, owner, 'the loser is told who has it');
  // Claiming your own again only updates the note; the other can't release it.
  const again = await store.claimRoadmapItem(card.id, owner as string, 'look done: exists');
  assert.equal(again.status, 'ok');
  assert.equal(again.status === 'ok' && again.item.note, 'look done: exists');
  const other = owner === 'claude' ? 'grok' : 'claude';
  assert.equal((await store.releaseRoadmapItem(card.id, other)).status, 'taken');
  assert.equal((await store.releaseRoadmapItem(card.id, owner as string)).status, 'ok');
  const free = await store.claimRoadmapItem(card.id, other, null);
  assert.equal(free.status === 'ok' && free.item.owner, other, 'free again, so the other can claim it');
  assert.equal(free.status === 'ok' && free.item.note, 'look done: exists', 'no note keeps the note');
  assert.equal((await store.claimRoadmapItem('rm_00000000', 'claude', null)).status, 'not_found');
}

test('claim lock (memory): one wins, the other learns who', async () => { await claimRules(createMemoryStore()); });
test('claim lock (PGlite): one wins, the other learns who', async () => {
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  await claimRules(store);
});

test('API: a claim on someone else\'s card is a 409 with the owner', async () => {
  const claimRoute = (await import('../app/api/roadmap/[id]/claim/route')) as unknown as { POST: Handler; DELETE: Handler };
  const created = ((await (await list.POST(req('david', 'POST', { column: 'next', title: 'Claim me' }))).json()) as { item: RoadmapItem }).item;
  const ctx = { params: Promise.resolve({ id: created.id }) };
  const path = `/api/roadmap/${created.id}/claim`;
  const first = await claimRoute.POST(req('grok', 'POST', { note: 'new' }, path), ctx);
  assert.equal(first.status, 200);
  const second = await claimRoute.POST(req('claude', 'POST', {}, path), ctx);
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { owner: string }).owner, 'grok');
  assert.equal((await claimRoute.DELETE(req('claude', 'DELETE', undefined, path), ctx)).status, 409);
  assert.equal((await claimRoute.DELETE(req('grok', 'DELETE', undefined, path), ctx)).status, 200);
});
