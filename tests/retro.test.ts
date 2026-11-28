// «Retro-Karte nach jedem Release»: the card's text, finding a release again, and the API (pretend GitHub, memory store).
import { afterAll, beforeAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { buildRetro, pickRelease, retroBase, retroNote, retroReleaseOf, RETRO_LIST_MAX } from '../lib/retro';
import { clearStreakCache, type Merge, type StreakBreak } from '../lib/streak';
import type { RoadmapItem } from '../lib/roadmap';

const merge = (number: number, merged_at: string, title = `PR ${number}`): Merge => ({ number, title, merged_at });
const brk = (id: number, created_at: string, participant = 'claude', reason = 'needed a Vercel setting'): StreakBreak => ({ id, participant, reason, created_at });

// Two releases into test: #117 at 03:46 UTC and #148 at 11:04 UTC on 28 November 2026.
const releases = [merge(148, '2026-11-28T11:04:27Z', 'Release: Playground b09d0be to the live hub (28 PRs, #116–#147)'), merge(117, '2026-11-28T03:46:13Z', 'v0.3 into test')];
const playground = [
  merge(100, '2026-11-28T01:00:00Z'), merge(101, '2026-11-28T03:00:00Z'),
  merge(120, '2026-11-28T04:00:00Z', 'Roadmap: Build it'), merge(121, '2026-11-28T05:00:00Z'), merge(122, '2026-11-28T08:00:00Z'),
  merge(123, '2026-11-28T11:04:27Z', 'merged at the very second of the release'),
  merge(130, '2026-11-28T12:00:00Z', 'after the release'),
];

test('the latest release is picked, or the one asked for; none is null', () => {
  assert.equal(pickRelease(releases)?.number, 148);
  assert.equal(pickRelease(releases, 117)?.number, 117);
  assert.equal(pickRelease(releases, 5), null);
  assert.equal(pickRelease([]), null);
  assert.equal(pickRelease([merge(1, 'not a date')]), null);
});

test('what shipped is every playground merge since the release before, up to this one', () => {
  const r = buildRetro(releases[0], releases, playground, []);
  assert.equal(r.shipped, 4, '120, 121, 122 and the one at the same second; not 100/101 (before #117) or 130 (after)');
  assert.match(r.description, /What shipped: 4 PRs\n- #120 Roadmap: Build it\n- #121 PR 121\n- #122 PR 122\n- #123 merged at the very second/);
  assert.doesNotMatch(r.description, /#130|#101/);
  assert.equal(r.title, 'Retro: release #148, 4 PRs');
  assert.equal(r.note, 'retro of release PR #148');
  assert.match(r.description, /^Release PR #148 «Release: Playground b09d0be to the live hub \(28 PRs, #116–#147\)», merged 28 Nov, 12:04 \(Zurich\)\./);
});

test('the first release covers everything so far, and a single PR is «1 PR»', () => {
  const first = buildRetro(releases[1], releases, playground, []);
  assert.equal(first.shipped, 2);
  assert.match(first.description, /Since the start\./);
  const one = buildRetro(releases[1], releases, [merge(1, '2026-11-28T01:00:00Z')], []);
  assert.equal(one.title, 'Retro: release #117, 1 PR');
  assert.match(one.description, /What shipped: 1 PR\n/);
});

test('the streak breaks in the window are what went wrong; none says so; the streak counts to the release', () => {
  const r = buildRetro(releases[0], releases, playground, [brk(1, '2026-11-28T02:00:00Z', 'david', 'before this window'), brk(2, '2026-11-28T06:00:00Z', 'claude', 'needed\na Vercel\tsetting'), brk(3, '2026-11-28T13:00:00Z', 'grok', 'after')]);
  assert.equal(r.breaks, 1);
  assert.match(r.description, /What went wrong, as the hub knows it \(the streak was ended\):\n- 28 Nov, 07:00 claude: needed a Vercel setting\n/);
  assert.doesNotMatch(r.description, /before this window|after\n/);
  // 100 → 1; break 02:00 → 0; 101, 120, 121 → 3 (the record); break 06:00 → 0; 122, 123 → 2.
  assert.match(r.description, /Streak at the release: 2 in a row \(record 3\)\./);
  const calm = buildRetro(releases[0], releases, playground, []);
  assert.equal(calm.breaks, 0);
  assert.match(calm.description, /- Nothing: the orchestrator did not have to step in\./);
  assert.match(calm.description, /Streak at the release: 6 in a row/);
});

test('three empty lines are left for the people, and a long list is cut but still counted', () => {
  const many = Array.from({ length: RETRO_LIST_MAX + 7 }, (_, i) => merge(200 + i, '2026-11-28T09:00:00Z', `Long ${i} ${'x'.repeat(200)}`));
  const r = buildRetro(releases[0], releases, many, []);
  assert.equal(r.shipped, RETRO_LIST_MAX + 7);
  assert.match(r.description, new RegExp(`What shipped: ${RETRO_LIST_MAX + 7} PRs`));
  const listed = r.description.split('\n').filter((l) => /^- #\d+ Long/.test(l)).length;
  assert.ok(listed > 0 && listed <= RETRO_LIST_MAX);
  assert.match(r.description, new RegExp(`- … and ${RETRO_LIST_MAX + 7 - listed} more\\n`), 'the rest is counted, whatever room the text had');
  assert.ok([...r.description].length <= 4000);
  assert.match(r.description, /What went well, in your words:\n\nWhat went wrong, in your words:\n\nWhat we change next time:$/);
  assert.ok([...r.title].length <= 80 && [...r.note].length <= 120);
});

test('the note finds the card again, and only that exact note', () => {
  assert.equal(retroNote(148), 'retro of release PR #148');
  assert.equal(retroReleaseOf(retroNote(148)), 148);
  for (const n of ['', 'from #148', 'retro of release PR #', 'retro of release PR #148 edited', 'Retro of release PR #1']) assert.equal(retroReleaseOf(n), null, n);
  assert.equal(retroBase({}), 'test');
  assert.equal(retroBase({ TRIALOG_RETRO_BASE: 'staging' }), 'staging');
  assert.equal(retroBase({ TRIALOG_RETRO_BASE: 'a b' }), 'test');
});

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let route: { GET: Handler; POST: Handler };
const TOKEN = { ana: 'ana-retro-token-0123456789abcdef', scout: 'scout-retro-token-0123456789abcd' };
let githubDown = false;
const row = (m: Merge) => ({ number: m.number, title: m.title, merged_at: m.merged_at, head: { ref: 'x/y' } });

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.PARTICIPANTS = 'ana:human:Ana,scout:agent';
  process.env.ANA_TOKEN = TOKEN.ana;
  process.env.SCOUT_TOKEN = TOKEN.scout;
  process.env.TRIALOG_REPO = 'owner/repo';
  (globalThis as { __collabHubStore?: unknown }).__collabHubStore = undefined;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.github.com') return realFetch(input, init);
    if (githubDown) return new Response('{}', { status: 503 });
    const base = url.searchParams.get('base');
    const list = base === 'test' ? releases : base === 'playground' ? playground : [];
    return new Response(JSON.stringify(Number(url.searchParams.get('page')) > 1 ? [] : list.map(row)), { status: 200 });
  });
  route = (await import('../app/api/retro/route')) as unknown as { GET: Handler; POST: Handler };
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const n of ['PARTICIPANTS', 'ANA_TOKEN', 'SCOUT_TOKEN', 'TRIALOG_REPO']) delete process.env[n];
  clearStreakCache();
});
beforeEach(() => { githubDown = false; clearStreakCache(); });

const call = (method: 'GET' | 'POST', who: keyof typeof TOKEN | null, path = '/api/retro', body?: unknown) =>
  route[method](new Request(`http://hub.test${path}`, { method, headers: { ...(who ? { Authorization: `Bearer ${TOKEN[who]}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }));

test('API: GET previews the latest release without adding a card; no token is 401', async () => {
  assert.equal((await call('GET', null)).status, 401);
  assert.equal((await call('POST', null)).status, 401);
  const res = await call('GET', 'scout');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { retro: { release: number; shipped: number }; card: RoadmapItem | null };
  assert.equal(body.retro.release, 148);
  assert.equal(body.retro.shipped, 4);
  assert.equal(body.card, null, 'a preview adds nothing');
  const other = (await (await call('GET', 'scout', '/api/retro?release=117')).json()) as { retro: { release: number } };
  assert.equal(other.retro.release, 117);
});

test('API: POST adds one card to Later, a second POST returns the same card, an edited description is kept', async () => {
  const first = await call('POST', 'scout');
  assert.equal(first.status, 201);
  const made = (await first.json()) as { card: RoadmapItem; created: boolean; retro: { title: string } };
  assert.equal(made.created, true);
  assert.equal(made.card.column, 'later');
  assert.equal(made.card.title, 'Retro: release #148, 4 PRs');
  assert.equal(made.card.note, 'retro of release PR #148');
  assert.equal(made.card.owner, null);
  assert.match(made.card.description, /What shipped: 4 PRs/);

  const roadmap = (await import('../app/api/roadmap/[id]/route')) as unknown as { PATCH: Handler };
  const edit = await roadmap.PATCH(new Request('http://hub.test/api/roadmap/x', { method: 'PATCH', headers: { Authorization: `Bearer ${TOKEN.ana}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'What went well: the guard held.' }) }), { params: Promise.resolve({ id: made.card.id }) });
  assert.equal(edit.status, 200);

  const again = await call('POST', 'ana', '/api/retro', {});
  assert.equal(again.status, 200);
  const same = (await again.json()) as { card: RoadmapItem; created: boolean };
  assert.equal(same.created, false);
  assert.equal(same.card.id, made.card.id);
  assert.equal(same.card.description, 'What went well: the guard held.');
  const list = (await (await (await import('../app/api/roadmap/route') as unknown as { GET: Handler }).GET(new Request('http://hub.test/api/roadmap', { headers: { Authorization: `Bearer ${TOKEN.ana}` } }))).json()) as { items: RoadmapItem[] };
  assert.equal(list.items.filter((i) => i.note === 'retro of release PR #148').length, 1);

  const older = await call('POST', 'scout', '/api/retro', { release: 117 });
  assert.equal(older.status, 201, 'an older release gets its own card');
  const got = (await (await call('GET', 'scout')).json()) as { card: RoadmapItem | null };
  assert.equal(got.card?.id, made.card.id, 'GET shows the card that is there');
});

test('API: bad input is 400, an unknown release 404, GitHub down 502, no repository 409', async () => {
  assert.equal((await call('GET', 'scout', '/api/retro?release=abc')).status, 400);
  assert.equal((await call('POST', 'scout', '/api/retro', { release: 'x' })).status, 400);
  assert.equal((await call('POST', 'scout', '/api/retro', { release: -3 })).status, 400);
  assert.equal((await call('POST', 'scout', '/api/retro', [])).status, 400);
  assert.equal((await call('POST', 'scout', '/api/retro', { release: 999 })).status, 404);
  clearStreakCache();
  githubDown = true;
  const down = await call('GET', 'scout');
  assert.equal(down.status, 502);
  assert.match(((await down.json()) as { error: string }).error, /GitHub answered 503/);
  githubDown = false;
  const repo = process.env.TRIALOG_REPO;
  delete process.env.TRIALOG_REPO;
  try { assert.equal((await call('GET', 'scout')).status, 409); } finally { process.env.TRIALOG_REPO = repo; }
});

test('hub.js has «retro», and docs/api.md says what the API does', async () => {
  const { readFileSync } = await import('node:fs');
  const hub = readFileSync(new URL('../scripts/hub.js', import.meta.url), 'utf8');
  assert.match(hub, /cmd === 'retro'/);
  assert.match(hub, /retro \[preview\] \[--release <pr>\]/);
  assert.match(readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8'), /### `GET \/api\/retro` and `POST \/api\/retro`/);
});
