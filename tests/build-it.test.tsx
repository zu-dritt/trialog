// «⚙️ Build it!»: title and description from the message, the Next card (top, note «from #N»,
// pictures copied when they can be), idempotency, the API (only the orchestrator, no PR messages,
// no wake), and the button / chip.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import type { Participant } from '../lib/shared';
import type { RoadmapItem } from '../lib/roadmap';
import { ROADMAP_TITLE_MAX } from '../lib/roadmap';
import {
  BUILD_NOTE, buildChipText, buildItFromMessage, cardHref, descriptionFromMessage, findBuiltCard,
  formatClock, sourceMessageOf, titleFromMessage,
} from '../lib/build-it';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { BuildIt, BUILD_HELP, BUILD_HELP_DISABLED, isBuildableMessage, isOrchestrator } from '../app/build-it';
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
  description: 'A weekly MVP card', attachments: [], reviewer: null, ...over,
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

test('the note «from #N» is how a card is found again', () => {
  assert.equal(BUILD_NOTE(12), 'from #12');
  assert.equal(sourceMessageOf('from #12'), 12);
  assert.equal(sourceMessageOf(' from #12 '), 12);
  assert.equal(sourceMessageOf('from #12, claimed'), null);
  const items = [card(), card({ id: 'rm_bbbbbbbb', note: 'other', title: 'Other' })];
  assert.equal(findBuiltCard(items, 12)?.id, 'rm_aaaaaaaa');
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
    assert.equal(first.item.note, `from #${m.id}`);
    assert.equal(first.item.owner, null);
    const next = (await store.listRoadmap()).filter((i) => i.column === 'next');
    assert.deepEqual(next.map((i) => i.title), ['A weekly MVP card', 'Older card']);
    assert.equal((await store.list({ since: 0 })).length, before, 'no hub message, so nobody is woken');

    const second = await buildItFromMessage(store, { messageId: m.id, by: 'david', humans: ['david'], namesPr: false });
    assert.equal(second.status, 'exists');
    if (second.status === 'exists') assert.equal(second.item.id, first.item.id);
    assert.equal((await store.listRoadmap()).filter((i) => i.note === `from #${m.id}`).length, 1);
  });

  test(`${name}: a message from an agent, or one that names a PR, is refused; pictures are copied`, async () => {
    const store = await make();
    const agent = await store.add({ sender: 'claude', recipient: null, text: 'I have an idea' });
    const pr = await store.add({ sender: 'david', recipient: null, text: 'PR 66 is up' });
    assert.ok(agent && pr);
    assert.equal((await buildItFromMessage(store, { messageId: agent.id, by: 'david', humans: ['david'], namesPr: false })).status, 'not_from_orchestrator');
    assert.equal((await buildItFromMessage(store, { messageId: pr.id, by: 'david', humans: ['david'], namesPr: true })).status, 'names_pr');
    assert.equal((await buildItFromMessage(store, { messageId: 999999, by: 'david', humans: ['david'], namesPr: false })).status, 'not_found');
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
  assert.equal(item.note, `from #${m.id}`);
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
