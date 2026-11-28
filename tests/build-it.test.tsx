// «⚙️ Build it!»: title and description from the message, the Next card (top, note «from #N»,
// pictures copied when they can be), idempotency, the API (only the orchestrator, no PR messages,
// no wake), and the button / chip.
import { afterEach, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import type { Participant } from '../lib/shared';
import type { RoadmapItem } from '../lib/roadmap';
import { ROADMAP_TITLE_MAX } from '../lib/roadmap';
import {
  BUILD_NOTE, buildChipText, buildItFromMessage, builtAtFromNote, cardHref, descriptionFromMessage,
  findBuiltCard, formatClock, sourceMessageOf, titleFromMessage,
} from '../lib/build-it';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { BuildIt, BUILD_HELP, BUILD_HELP_DISABLED, BUILD_IT_QUIET_CLASS, isBuildableMessage, isOrchestrator, isQuietBuildIt, loadRoadmapOnce, rememberBuiltCard, resetRoadmapCache } from '../app/build-it';
import { linksPullRequest } from '../app/links';

const AT = '2026-11-27T12:48:00.000Z';
const people: Participant[] = [
  { name: 'david', label: 'Orchestrator', kind: 'human', color: 0 },
  { name: 'claude', label: 'Claude', kind: 'agent', color: 1 },
  { name: 'grok', label: 'Grok', kind: 'agent', color: 2 },
];
const base = (over: Partial<Message> = {}): Message => ({
  id: 12, sender: 'david', recipient: null, text: 'A weekly MVP card', created_at: AT,
  pinned_at: null, room: 'main', attachments: [], reply_to: null, poll: null, reactions: [], ...over,
});
const card = (over: Partial<RoadmapItem> = {}): RoadmapItem => ({
  id: 'rm_aaaaaaaa', column: 'next', position: 0, title: 'A weekly MVP card', note: 'from #12',
  owner: null, updated_by: 'david', updated_at: AT, progress: null, status: '', progress_at: null,
  description: 'A weekly MVP card', attachments: [], reviewer: null, raised_by: null, moved_by: null, moved_at: null, entered_next_at: null, ...over,
});

test('the title is the first line, at most 80 characters, and «Message #N» when empty', () => {
  assert.equal(titleFromMessage('A weekly MVP card\nMore detail below.', 12), 'A weekly MVP card');
  assert.equal(titleFromMessage('  \n  Trim me  \n', 12), 'Trim me');
  assert.equal(titleFromMessage('x'.repeat(90), 12).length, ROADMAP_TITLE_MAX);
  assert.equal(titleFromMessage('', 12), 'Message #12');
  assert.equal(titleFromMessage('   \n\n', 7), 'Message #7');
  assert.equal([...titleFromMessage('🎉'.repeat(81), 1)].length, 80, 'counted in characters, not UTF-16 units');
});

test('the description keeps line breaks and is cut at 4000 characters', () => {
  assert.equal(descriptionFromMessage(' line one\r\nline two\n\n\n\n\nend '), 'line one\nline two\n\n\nend');
  assert.equal(descriptionFromMessage('x'.repeat(4001)).length, 4000);
  assert.equal(descriptionFromMessage('ok\x07done'), 'okdone');
});

test('the note «from #N» is how a card is found again, even if later text is added', () => {
  assert.equal(BUILD_NOTE(12), 'from #12');
  assert.equal(BUILD_NOTE(12, AT), 'from #12 at 2026-11-27T12:48:00.000Z');
  assert.equal(sourceMessageOf('from #12'), 12);
  assert.equal(sourceMessageOf(' from #12 '), 12);
  assert.equal(sourceMessageOf('from #12, claimed'), 12, 'an edited note that still starts with «from #N» is the same card');
  assert.equal(sourceMessageOf('from #12 at 2026-11-27T12:48:00.000Z'), 12);
  assert.equal(sourceMessageOf('see from #12'), null);
  assert.equal(sourceMessageOf('from #12x'), null);
  assert.equal(builtAtFromNote('from #12 at 2026-11-27T12:48:00.000Z'), AT);
  assert.equal(builtAtFromNote('from #12'), undefined);
  const items = [
    card({ note: 'from #12 at 2026-11-27T12:48:00.000Z' }),
    card({ id: 'rm_bbbbbbbb', note: 'other', title: 'Other' }),
    card({ id: 'rm_cccccccc', note: 'from #12, claimed', title: 'Edited note' }),
  ];
  assert.equal(findBuiltCard(items, 12)?.id, 'rm_aaaaaaaa');
  assert.equal(findBuiltCard([items[2]], 12)?.id, 'rm_cccccccc');
  assert.equal(findBuiltCard(items, 99), undefined);
});

test('the chip says «⚙️ go to build · HH:MM → card» and links to the card', () => {
  assert.equal(formatClock(AT), '13:48');
  assert.equal(buildChipText(AT), '⚙️ go to build · 13:48 → card');
  assert.equal(buildChipText(), '⚙️ go to build → card');
  assert.equal(cardHref('rm_aaaaaaaa'), '/roadmap#rm_aaaaaaaa');
});

test('only an orchestrator message that names no pull request is buildable, and only they can press it', () => {
  assert.equal(isOrchestrator('david', people), true);
  assert.equal(isOrchestrator('claude', people), false);
  assert.equal(isOrchestrator(null, people), false);
  assert.equal(isBuildableMessage(base(), people, false), true);
  assert.equal(isBuildableMessage(base({ sender: 'claude' }), people, false), false);
  assert.equal(isBuildableMessage(base({ text: 'PR 66 is up' }), people, true), false);
  // A go from a roadmap card is an answer, not a new idea: no second card from it (#1185).
  assert.equal(isBuildableMessage(base({ text: '🚀 Build it! «Sounds» (roadmap card rm_1, now at the top of Now). First claim wins.' }), people, false), false);
  assert.equal(isBuildableMessage(base({ text: '@claude 🚀 Build it! «Sounds» (roadmap card rm_1, now at the top of Now)' }), people, false), false);
  assert.equal(isBuildableMessage(base({ text: 'Build it like this: two sounds' }), people, false), true);
});

test('the button, a disabled button for an agent, and the chip once a card exists', () => {
  const btn = renderToStaticMarkup(<BuildIt message={base()} me="david" participants={people} />);
  assert.match(btn, /⚙️ Build it!/);
  assert.match(btn, /data-build=""/);
  assert.ok(!btn.includes('disabled'), btn);
  assert.ok(btn.includes(BUILD_HELP.replace("'", '&#x27;')) || btn.includes(BUILD_HELP), btn);

  const asAgent = renderToStaticMarkup(<BuildIt message={base()} me="claude" participants={people} />);
  assert.match(asAgent, /disabled=""/);
  assert.ok(asAgent.includes(BUILD_HELP_DISABLED), asAgent);

  const chip = renderToStaticMarkup(<BuildIt message={base()} me="david" participants={people} card={card()} />);
  assert.match(chip, /⚙️ go to build · 13:48 → card/);
  assert.match(chip, /href="\/roadmap#rm_aaaaaaaa"/);
  assert.match(chip, /data-build-card="rm_aaaaaaaa"/);
  assert.ok(!chip.includes('Build it!'), 'the button is replaced by the chip');

  const later = '2026-11-27T18:00:00.000Z';
  const frozen = renderToStaticMarkup(
    <BuildIt message={base()} me="david" participants={people} card={card({ note: `from #12 at ${AT}`, updated_at: later })} />,
  );
  assert.match(frozen, /⚙️ go to build · 13:48 → card/, 'the click time in the note holds still after an edit bumps updated_at');
  assert.ok(!frozen.includes('19:00'), frozen);
});

afterEach(() => { vi.useRealTimers(); });

test('a message older than today is quiet until hover or focus; today and the chip are not', () => {
  const now = new Date('2026-11-27T14:00:00.000Z');
  assert.equal(isQuietBuildIt(AT, now), false, 'today in Europe/Zurich');
  assert.equal(isQuietBuildIt('2026-11-26T12:00:00.000Z', now), true);
  assert.equal(isQuietBuildIt('2026-11-26T23:30:00.000Z', now), false, 'already 00:30 on the 27th in Zurich');
  // The component asks the real clock; pin it to the same «now», or this fails on any other day (playground #942).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const today = renderToStaticMarkup(<BuildIt message={base()} me="david" participants={people} />);
  assert.ok(!today.includes('data-build-quiet'), today);
  assert.ok(!today.includes(BUILD_IT_QUIET_CLASS), today);
  const old = renderToStaticMarkup(<BuildIt message={base({ created_at: '2026-11-26T12:00:00.000Z' })} me="david" participants={people} />);
  assert.match(old, /data-build-quiet=""/);
  assert.ok(old.includes(BUILD_IT_QUIET_CLASS), old);
  const chip = renderToStaticMarkup(
    <BuildIt message={base({ created_at: '2026-11-26T12:00:00.000Z' })} me="david" participants={people} card={card()} />,
  );
  assert.ok(!chip.includes('data-build-quiet'), 'the chip stays visible');
  assert.ok(!chip.includes(BUILD_IT_QUIET_CLASS), chip);
});

test('the roadmap is loaded once and shared, then the cache is updated after a POST', async () => {
  resetRoadmapCache();
  let n = 0;
  const items = [card()];
  const api = async (path: string) => {
    n += 1;
    assert.equal(path, '/api/roadmap');
    return new Response(JSON.stringify({ items }), { headers: { 'Content-Type': 'application/json' } });
  };
  const first = loadRoadmapOnce(api);
  const second = loadRoadmapOnce(api);
  assert.equal(await first, await second);
  assert.equal((await first).map((i) => i.id).join(), 'rm_aaaaaaaa');
  assert.equal(n, 1, 'one GET for every button on the page');
  const added = card({ id: 'rm_bbbbbbbb', note: 'from #99' });
  rememberBuiltCard(added);
  const after = await loadRoadmapOnce(api);
  assert.equal(after.some((i) => i.id === 'rm_bbbbbbbb'), true);
  assert.equal(n, 1, 'a successful POST does not refetch the whole list');
  resetRoadmapCache();
  await loadRoadmapOnce(api);
  assert.equal(n, 2, 'a reset lets the next page load fetch again');
  resetRoadmapCache();
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const STORES: [string, () => Promise<Store>][] = [
  ['memory (demo hub)', async () => createMemoryStore()],
  ['sql (PGlite)', async () => { const s = createSqlStore(pgliteDb(new PGlite())); await s.ensure(); return s; }],
];

for (const [name, make] of STORES) {
  test(`${name}: a click puts a card at the top of Next, and a second click returns the same card`, async () => {
    const store = await make();
    await store.addRoadmapItem({ column: 'next', title: 'Older card', note: '', owner: null, by: 'grok' });
    const m = await store.add({ sender: 'david', recipient: null, text: 'A weekly MVP card\nPick one each week.' });
    assert.ok(m);
    const before = (await store.list({ since: 0 })).length;
    const first = await buildItFromMessage(store, { messageId: m.id, by: 'david', humans: ['david'], namesPr: false });
    assert.equal(first.status, 'created');
    if (first.status !== 'created') return;
    assert.equal(first.item.column, 'next');
    assert.equal(first.item.position, 0, 'top of Next');
    assert.equal(first.item.title, 'A weekly MVP card');
    assert.equal(first.item.description, 'A weekly MVP card\nPick one each week.');
    assert.equal(sourceMessageOf(first.item.note), m.id);
    assert.equal(builtAtFromNote(first.item.note) !== undefined, true, 'the click time is in the note so the chip stays put');
    assert.equal(first.item.owner, null);
    const next = (await store.listRoadmap()).filter((i) => i.column === 'next');
    assert.deepEqual(next.map((i) => i.title), ['A weekly MVP card', 'Older card']);
    assert.equal((await store.list({ since: 0 })).length, before, 'no hub message, so nobody is woken');

    const second = await buildItFromMessage(store, { messageId: m.id, by: 'david', humans: ['david'], namesPr: false });
    assert.equal(second.status, 'exists');
    if (second.status === 'exists') assert.equal(second.item.id, first.item.id);
    assert.equal((await store.listRoadmap()).filter((i) => sourceMessageOf(i.note) === m.id).length, 1);
  });

  test(`${name}: two posts at the same moment create only one card`, async () => {
    const store = await make();
    const m = await store.add({ sender: 'david', recipient: null, text: 'Make this atomic' });
    assert.ok(m);
    const input = { messageId: m.id, by: 'david' as const, humans: ['david'], namesPr: false };
    const [a, b] = await Promise.all([buildItFromMessage(store, input), buildItFromMessage(store, input)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ['created', 'exists']);
    const id = a.status === 'created' || a.status === 'exists' ? a.item.id : '';
    const other = b.status === 'created' || b.status === 'exists' ? b.item.id : '';
    assert.equal(id, other);
    assert.equal((await store.listRoadmap()).filter((i) => sourceMessageOf(i.note) === m.id).length, 1);
  });

  test(`${name}: a message from an agent, or one that names a PR, is refused; pictures are copied`, async () => {
    const store = await make();
    const agent = await store.add({ sender: 'claude', recipient: null, text: 'I have an idea' });
    const pr = await store.add({ sender: 'david', recipient: null, text: 'PR 66 is up' });
    assert.ok(agent && pr);
    assert.equal((await buildItFromMessage(store, { messageId: agent.id, by: 'david', humans: ['david'], namesPr: false })).status, 'not_from_orchestrator');
    assert.equal((await buildItFromMessage(store, { messageId: pr.id, by: 'david', humans: ['david'], namesPr: true })).status, 'names_pr');
    assert.equal((await buildItFromMessage(store, { messageId: 999999, by: 'david', humans: ['david'], namesPr: false })).status, 'not_found');
    // A go is an answer, not an idea: the server refuses to make a card of it, whatever the page shows (#1219).
    for (const text of ['🚀 Build it! «Sounds» (roadmap card rm_1, now at the top of Now). First claim wins.', '@claude 🚀 Build it! «Sounds» (roadmap card rm_1)', '🚀 Ship it! PR 7']) {
      const go = await store.add({ sender: 'david', recipient: null, text });
      assert.ok(go);
      assert.equal((await buildItFromMessage(store, { messageId: go.id, by: 'david', humans: ['david'], namesPr: false })).status, 'is_go', text);
    }
    assert.equal((await store.listRoadmap()).length, 0);

    const png = { content_type: 'image/png' as const, width: 4, height: 3, data: Buffer.from('picture-build-it') };
    const att = (await store.addAttachment({ sender: 'david', ...png }))!;
    const withPic = await store.add({ sender: 'david', recipient: null, text: 'A shot of the bug', attachments: [att.id] });
    assert.ok(withPic);
    const built = await buildItFromMessage(store, { messageId: withPic.id, by: 'david', humans: ['david'], namesPr: false });
    assert.equal(built.status, 'created');
    if (built.status !== 'created') return;
    assert.equal(built.item.attachments.length, 1, 'the message picture was copied onto the card');
    assert.notEqual(built.item.attachments[0].id, att.id, 'a new upload: the message keeps its own');
    assert.equal((await store.getAttachment(att.id))?.attachment.message_id, withPic.id);
    assert.equal((await store.getAttachment(built.item.attachments[0].id))?.attachment.roadmap_item_id, built.item.id);
  });
}

const TOKENS: Record<string, string> = { david: 'david-build-it-token-0123456789ab', claude: 'claude-build-it-token-0123456789', grok: 'grok-build-it-token-0123456789abc' };
type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let route: { GET: Handler; POST: Handler };
let postMessage: (who: string, text: string) => Promise<Message>;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.DAVID_TOKEN = TOKENS.david;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.TRIALOG_REPO = 'zu-dritt/trialog';
  console.warn = () => {};
  route = (await import('../app/api/messages/[id]/build-it/route')) as unknown as typeof route;
  const messages = (await import('../app/api/messages/route')) as unknown as { POST: (req: Request) => Promise<Response> };
  postMessage = async (who, text) => {
    const res = await messages.POST(new Request('http://hub.test/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKENS[who]}` }, body: JSON.stringify({ text }),
    }));
    if (res.status !== 201) assert.equal(res.status, 201, await res.text());
    return ((await res.json()) as { message: Message }).message;
  };
});

const call = (method: string, id: string | number, who?: string) => route[method === 'GET' ? 'GET' : 'POST'](
  new Request(`http://hub.test/api/messages/${id}/build-it`, { method, headers: { ...(who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {}) } }),
  { params: Promise.resolve({ id: String(id) }) },
);

test('API: only the orchestrator can create the card; a second post returns the same one; nobody is woken', async () => {
  assert.equal((await call('POST', 1)).status, 401);
  const m = await postMessage('david', 'The claim draft:\ntake turns picking.');
  const listed = (await import('../app/api/messages/route')) as unknown as { GET: (req: Request) => Promise<Response> };
  const before = ((await (await listed.GET(new Request('http://hub.test/api/messages?since=0', { headers: { Authorization: `Bearer ${TOKENS.david}` } }))).json()) as { messages: Message[] }).messages.length;
  assert.equal((await call('POST', m.id, 'claude')).status, 403);
  assert.equal((await call('GET', m.id, 'claude')).status, 404, 'nothing created by the refused post');
  const created = await call('POST', m.id, 'david');
  assert.equal(created.status, 201);
  const { item } = (await created.json()) as { item: RoadmapItem };
  assert.equal(item.column, 'next');
  assert.equal(item.position, 0);
  assert.equal(item.title, 'The claim draft:');
  assert.equal(item.description, 'The claim draft:\ntake turns picking.');
  assert.equal(sourceMessageOf(item.note), m.id);
  assert.equal(builtAtFromNote(item.note) !== undefined, true);
  const again = await call('POST', m.id, 'david');
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { item: RoadmapItem }).item.id, item.id);
  const got = await call('GET', m.id, 'claude');
  assert.equal(got.status, 200, 'anyone signed in can see the existing card');
  assert.equal(((await got.json()) as { item: RoadmapItem }).item.id, item.id);
  const after = ((await (await listed.GET(new Request('http://hub.test/api/messages?since=0', { headers: { Authorization: `Bearer ${TOKENS.david}` } }))).json()) as { messages: Message[] }).messages.length;
  assert.equal(after, before, 'no new hub message');
});

test('API: a message that names a PR, or one from an agent, is refused; a missing id is 404', async () => {
  const pr = await postMessage('david', 'PR 66 is up');
  const agent = await postMessage('claude', 'I have an idea for the board');
  assert.equal((await call('POST', pr.id, 'david')).status, 400);
  assert.equal((await call('POST', agent.id, 'david')).status, 400);
  assert.equal((await call('POST', 999999, 'david')).status, 404);
  assert.equal((await call('POST', 'nope', 'david')).status, 400);
  assert.equal(linksPullRequest('PR 66 is up', 'zu-dritt/trialog'), true);
});

test('API: two posts at the same moment return the same card', async () => {
  const m = await postMessage('david', 'Race me into a card');
  const [a, b] = await Promise.all([call('POST', m.id, 'david'), call('POST', m.id, 'david')]);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses[0] === 200 && statuses[1] === 201, `expected 200 and 201, got ${statuses}`);
  const idA = ((await a.json()) as { item: RoadmapItem }).item.id;
  const idB = ((await b.json()) as { item: RoadmapItem }).item.id;
  assert.equal(idA, idB);
});
