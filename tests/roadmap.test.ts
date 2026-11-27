// The roadmap: input rules, both stores (memory and PGlite) and the API.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { parseItemChange, parseNewItem, parseOrder, type RoadmapItem } from '../lib/roadmap';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';

const NAMES = ['david', 'claude', 'grok'];

test('a new card needs a column and a title; note and owner are optional, and the owner must be a participant', () => {
  assert.deepEqual(parseNewItem({ column: 'next', title: '  Deploy\nbutton ' }, NAMES), { ok: true, column: 'next', title: 'Deploy button', note: '', owner: null, description: '', attachments: [], top: false, reviewer: null });
  assert.deepEqual(parseNewItem({ column: 'now', title: 'x', note: 'y', owner: 'grok' }, NAMES), { ok: true, column: 'now', title: 'x', note: 'y', owner: 'grok', description: '', attachments: [], top: false, reviewer: null });
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

test('progress: only the owner (or a human) says how far a card is; the bar and line come back with the card', async () => {
  for (const store of [createMemoryStore(), await (async () => { const s = createSqlStore(pgliteDb(new PGlite())); await s.ensure(); return s; })()]) {
    const c = (await store.addRoadmapItem({ column: 'now', title: 'Murten', note: '', owner: null, by: 'david' }))!;
    assert.equal(c.progress, null);
    assert.equal((await store.setRoadmapProgress(c.id, 'grok', 40, 'geocoding', false)).status, 'taken', 'claim first');
    await store.claimRoadmapItem(c.id, 'grok', null);
    const r = await store.setRoadmapProgress(c.id, 'grok', 60, 'geocoding done', false);
    assert.equal(r.status, 'ok');
    assert.equal(r.status === 'ok' && r.item.progress, 60);
    assert.equal(r.status === 'ok' && r.item.status, 'geocoding done');
    assert.ok(r.status === 'ok' && r.item.progress_at);
    assert.equal((await store.setRoadmapProgress(c.id, 'claude', 90, 'x', false)).status, 'taken', 'not the owner');
    assert.equal((await store.setRoadmapProgress(c.id, 'david', 70, 'checked by the orchestrator', true)).status, 'ok', 'a human may');
    const cleared = await store.setRoadmapProgress(c.id, 'grok', null, '', false);
    assert.equal(cleared.status === 'ok' && cleared.item.progress, null);
  }
  const { parseProgress } = await import('../lib/roadmap');
  assert.deepEqual(parseProgress({ progress: 60, status: ' half ' }), { ok: true, progress: 60, status: 'half' });
  assert.deepEqual(parseProgress({ progress: null }), { ok: true, progress: null, status: '' });
  assert.deepEqual(parseProgress({ progress: 80 }), { ok: true, progress: 80, status: null }, 'no status: the line stays');
  for (const bad of [{}, { progress: 101 }, { progress: -1 }, { progress: 2.5 }, { progress: '50' }, { progress: 5, status: 'x'.repeat(81) }]) assert.equal(parseProgress(bad).ok, false, JSON.stringify(bad));
});

test('the lock has no back door: an agent cannot move a claim with PATCH; the orchestrator can hand a card over; done cards are not claimed', async () => {
  const claimRoute = (await import('../app/api/roadmap/[id]/claim/route')) as unknown as { POST: Handler };
  const c = ((await (await list.POST(req('david', 'POST', { column: 'next', title: 'Back door' }))).json()) as { item: RoadmapItem }).item;
  const ctx = { params: Promise.resolve({ id: c.id }) };
  const path = `/api/roadmap/${c.id}`;
  assert.equal((await claimRoute.POST(req('grok', 'POST', {}, `${path}/claim`), ctx)).status, 200);
  const steal = await one.PATCH(req('claude', 'PATCH', { owner: 'claude' }, path), ctx);
  assert.equal(steal.status, 409, 'a claim cannot be overwritten');
  assert.equal(((await steal.json()) as { owner: string }).owner, 'grok');
  assert.equal((await one.PATCH(req('claude', 'PATCH', { owner: 'grok' }, path), ctx)).status, 403, 'agents take cards for themselves only');
  const handed = await one.PATCH(req('david', 'PATCH', { owner: 'claude' }, path), ctx);
  assert.equal(((await handed.json()) as { item: RoadmapItem }).item.owner, 'claude', 'the orchestrator may hand a card to anyone');
  assert.equal((await one.PATCH(req('claude', 'PATCH', { owner: null, title: 'Back door, closed' }, path), ctx)).status, 200, 'letting go of your own works');
  await one.PATCH(req('david', 'PATCH', { column: 'done' }, path), ctx);
  const late = await claimRoute.POST(req('grok', 'POST', {}, `${path}/claim`), ctx);
  assert.equal(late.status, 409);
  assert.match(((await late.json()) as { error: string }).error, /done/);
});

test('API: progress is 400 for a bad body, 404 for no card, 409 before the claim or for another agent, 200 for the owner; the line stays without a status', async () => {
  const route = (await import('../app/api/roadmap/[id]/progress/route')) as unknown as { PUT: Handler };
  const claimRoute = (await import('../app/api/roadmap/[id]/claim/route')) as unknown as { POST: Handler };
  const c = ((await (await list.POST(req('david', 'POST', { column: 'now', title: 'Progress via HTTP' }))).json()) as { item: RoadmapItem }).item;
  const ctx = { params: Promise.resolve({ id: c.id }) };
  const path = `/api/roadmap/${c.id}/progress`;
  const put = (who: string, body: unknown, at = ctx) => route.PUT(req(who, 'PUT', body, path), at);
  assert.equal((await put('grok', { progress: 101 })).status, 400);
  assert.equal((await put('grok', { progress: 5 }, { params: Promise.resolve({ id: 'rm_00000000' }) })).status, 404);
  const unclaimed = await put('grok', { progress: 5 });
  assert.equal(unclaimed.status, 409);
  assert.match(((await unclaimed.json()) as { error: string }).error, /Claim the card first/);
  await claimRoute.POST(req('grok', 'POST', {}, `/api/roadmap/${c.id}/claim`), ctx);
  const other = await put('claude', { progress: 5 });
  assert.equal(other.status, 409);
  assert.match(((await other.json()) as { error: string }).error, /grok's card/);
  assert.equal((await put('grok', { progress: 40, status: 'geocoding' })).status, 200);
  const kept = ((await (await put('grok', { progress: 60 })).json()) as { item: RoadmapItem }).item;
  assert.equal(kept.progress, 60);
  assert.equal(kept.status, 'geocoding', 'no status: the line stays');
  const byHuman = ((await (await put('david', { progress: 90, status: 'checked' })).json()) as { item: RoadmapItem }).item;
  assert.equal(byHuman.status, 'checked', 'a human may');
  const cleared = ((await (await put('grok', { progress: null })).json()) as { item: RoadmapItem }).item;
  assert.deepEqual([cleared.progress, cleared.status], [null, '']);
});

async function detailRules(store: Store) {
  const png = (n: string) => ({ content_type: 'image/png' as const, width: 4, height: 3, data: Buffer.from(`picture ${n}`) });
  const a = (await store.addAttachment({ sender: 'david', ...png('a') }))!;
  const b = (await store.addAttachment({ sender: 'david', ...png('b') }))!;
  const theirs = (await store.addAttachment({ sender: 'grok', ...png('c') }))!;
  await store.addRoadmapItem({ column: 'later', title: 'Older idea', note: '', owner: null, by: 'david' });
  const card = (await store.addRoadmapItem({ column: 'later', title: 'Compose window', note: '', owner: null, by: 'david', description: 'Like Gmail:\nCompose opens a window.', attachments: [b.id, a.id], top: true }))!;
  assert.equal(card.description, 'Like Gmail:\nCompose opens a window.');
  assert.deepEqual(card.attachments.map((x) => x.id), [b.id, a.id], 'pictures in the order given');
  assert.equal(card.position, 0, 'top: first in its column');
  const later = (await store.listRoadmap()).filter((i) => i.column === 'later');
  assert.deepEqual(later.map((i) => i.title), ['Compose window', 'Older idea']);
  assert.deepEqual(later[0].attachments.map((x) => x.id), [b.id, a.id], 'the list carries the pictures too');
  assert.equal((await store.getAttachment(a.id))?.attachment.roadmap_item_id, card.id, 'the picture knows its card');
  await assert.rejects(store.addRoadmapItem({ column: 'later', title: 'x', note: '', owner: null, by: 'david', attachments: [a.id] }), /already belongs/);
  await assert.rejects(store.addRoadmapItem({ column: 'later', title: 'x', note: '', owner: null, by: 'david', attachments: [theirs.id] }), /someone else/);
  await assert.rejects(store.addRoadmapItem({ column: 'later', title: 'x', note: '', owner: null, by: 'david', attachments: ['att_00000000000000000000000000'] }), /does not exist/);
  assert.equal((await store.listRoadmap()).length, 2, 'a refused picture adds no card');
  await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'reuse', attachments: [a.id] }), /already belongs/, 'a card picture cannot also go on a message');
  const edited = (await store.updateRoadmapItem(card.id, { description: 'Shorter.' }, 'david'))!;
  assert.equal(edited.description, 'Shorter.');
  assert.equal(edited.attachments.length, 2, 'editing the text keeps the pictures');
  assert.equal(await store.deleteRoadmapItem(card.id), true);
  assert.equal(await store.getAttachment(a.id), null, 'a deleted card takes its pictures with it, at once');
}

test('card details (memory): a description, pictures in order, at the top; only your own unlinked uploads', async () => { await detailRules(createMemoryStore()); });
test('card details (PGlite): the same', async () => {
  const store = createSqlStore(pgliteDb(new PGlite()));
  await store.ensure();
  await detailRules(store);
});

test('description: line breaks stay, other control characters and more than 4000 characters do not', async () => {
  const ok = parseNewItem({ column: 'later', title: 'Idea', description: ' line one\r\nline two\n\n\n\n\nend ', attachments: ['att_abc123'], top: true }, NAMES);
  assert.deepEqual(ok, { ok: true, column: 'later', title: 'Idea', note: '', owner: null, description: 'line one\nline two\n\n\nend', attachments: ['att_abc123'], top: true, reviewer: null });
  assert.equal(parseNewItem({ column: 'later', title: 'x', description: 'bell\x07' }, NAMES).ok, false);
  assert.equal(parseNewItem({ column: 'later', title: 'x', description: 'x'.repeat(4001) }, NAMES).ok, false);
  assert.equal(parseNewItem({ column: 'later', title: 'x', attachments: ['att_a', 'att_a'] }, NAMES).ok, false, 'no duplicates');
  assert.equal(parseNewItem({ column: 'later', title: 'x', attachments: Array.from({ length: 7 }, (_, i) => `att_${i}`) }, NAMES).ok, false, 'at most six');
  assert.equal(parseNewItem({ column: 'later', title: 'x', top: 'yes' }, NAMES).ok, false);
  assert.deepEqual(parseItemChange({ description: 'a\nb' }, NAMES), { ok: true, change: { description: 'a\nb' } });
});

test('API: a card with pictures; a stranger’s upload is 403; everyone signed in can see a card’s picture', async () => {
  const uploads = (await import('../app/api/attachments/route')) as unknown as { POST: Handler };
  const picture = (await import('../app/api/attachments/[id]/route')) as unknown as { GET: Handler };
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#f85149' } }).png().toBuffer();
  const up = async (who: string) => ((await (await uploads.POST(new Request('http://hub.test/api/attachments', { method: 'POST', headers: { Authorization: `Bearer ${TOKENS[who]}` }, body: new Uint8Array(bytes) }))).json()) as { id: string }).id;
  const mine = await up('david');
  const grokS = await up('grok');
  assert.equal((await list.POST(req('david', 'POST', { column: 'later', title: 'With a stranger’s picture', attachments: [grokS] }))).status, 403);
  const res = await list.POST(req('david', 'POST', { column: 'later', title: 'Compose like Gmail', description: 'A window\nwith pictures', attachments: [mine], top: true }));
  assert.equal(res.status, 201);
  const item = ((await res.json()) as { item: RoadmapItem }).item;
  assert.deepEqual([item.description, item.attachments.map((a) => a.id)], ['A window\nwith pictures', [mine]]);
  const seen = await picture.GET(new Request(`http://hub.test/api/attachments/${mine}`, { headers: { Authorization: `Bearer ${TOKENS.claude}` } }), { params: Promise.resolve({ id: mine }) });
  assert.equal(seen.status, 200, 'on a card, so not only its uploader can see it');
  assert.equal((await list.POST(req('david', 'POST', { column: 'later', title: 'Again', attachments: [mine] }))).status, 409);
});

test('a reviewer on a card: set when adding or later, any participant or none; «Claude builds · Grok reviews»', async () => {
  for (const store of [createMemoryStore(), await (async () => { const s = createSqlStore(pgliteDb(new PGlite())); await s.ensure(); return s; })()]) {
    const c = (await store.addRoadmapItem({ column: 'now', title: 'Reviewed', note: '', owner: 'claude', by: 'claude', reviewer: 'grok' }))!;
    assert.deepEqual([c.owner, c.reviewer], ['claude', 'grok']);
    assert.equal((await store.updateRoadmapItem(c.id, { reviewer: null }, 'grok'))!.reviewer, null);
    assert.equal((await store.updateRoadmapItem(c.id, { reviewer: 'david' }, 'claude'))!.reviewer, 'david');
    assert.equal((await store.updateRoadmapItem(c.id, { note: 'x' }, 'claude'))!.reviewer, 'david', 'other changes keep it');
  }
  assert.equal(parseNewItem({ column: 'now', title: 'x', reviewer: 'nobody' }, NAMES).ok, false);
  assert.match((parseNewItem({ column: 'now', title: 'x', reviewer: 'nobody' }, NAMES) as { error: string }).error, /"reviewer"/);
  assert.deepEqual(parseItemChange({ reviewer: 'grok' }, NAMES), { ok: true, change: { reviewer: 'grok' } });
  const res = await one.PATCH(req('claude', 'PATCH', { reviewer: 'grok' }, '/api/roadmap/rm_00000000'), { params: Promise.resolve({ id: 'rm_00000000' }) });
  assert.equal(res.status, 404);
});

test('who raised a card: whoever added it, kept through edits, claims and moves (playground #670)', async () => {
  for (const store of [createMemoryStore(), await (async () => { const s = createSqlStore(pgliteDb(new PGlite())); await s.ensure(); return s; })()]) {
    const c = (await store.addRoadmapItem({ column: 'next', title: 'Raised', note: '', owner: null, by: 'david' }))!;
    assert.equal(c.raised_by, 'david');
    assert.equal((await store.updateRoadmapItem(c.id, { note: 'x', column: 'now' }, 'grok'))!.raised_by, 'david', 'an edit by someone else keeps it');
    const claimed = await store.claimRoadmapItem(c.id, 'claude', null);
    assert.equal('item' in claimed ? claimed.item.raised_by : null, 'david', 'a claim keeps it');
    assert.equal((await store.listRoadmap()).find((i) => i.id === c.id)!.raised_by, 'david');
  }
  assert.ok(!('raised_by' in (parseItemChange({ raised_by: 'grok', note: 'x' }, NAMES) as { change: object }).change), 'a change cannot set it');
});

test('a card from before migration 019 reads raised_by null (PGlite)', async () => {
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  const c = (await store.addRoadmapItem({ column: 'next', title: 'Old card', note: '', owner: null, by: 'grok' }))!;
  await pg.query('UPDATE roadmap_items SET raised_by = NULL WHERE id = $1', [c.id]); // as an old row has it
  assert.equal((await store.listRoadmap()).find((i) => i.id === c.id)!.raised_by, null);
  assert.equal((await store.updateRoadmapItem(c.id, { note: 'x' }, 'claude'))!.raised_by, null, 'an edit does not invent one');
});
