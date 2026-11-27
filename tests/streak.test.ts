// The streak: counting merges and breaks, reading GitHub (with a pretend fetch), both stores and the API.
import { beforeAll, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { cachedMerges, clearStreakCache, computeStreak, fetchMerges, parseStreakBreak, streakBase, type Merge, type StreakBreak, type StreakReport } from '../lib/streak';
import { createMemoryStore, createSqlStore, type Db, type Row } from '../lib/store';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 27, h, m)).toISOString();
const merge = (number: number, time: string): Merge => ({ number, title: `PR ${number}`, merged_at: time });
const brk = (id: number, time: string, participant = 'david', reason = 'stepped in'): StreakBreak => ({ id, participant, reason, created_at: time });

test('the streak grows with each merge, drops to zero at a break, and the record only goes up', () => {
  const s = computeStreak(
    [merge(1, at(1)), merge(2, at(2)), merge(3, at(3)), merge(4, at(5)), merge(5, at(6))],
    [brk(1, at(4), 'claude', 'needed a Vercel setting')],
  );
  assert.equal(s.current, 2);
  assert.equal(s.record, 3);
  assert.equal(s.record_at, at(3));
  assert.deepEqual(s.points.map((p) => [p.value, p.record]), [[1, 1], [2, 2], [3, 3], [0, 3], [1, 3], [2, 3]]);
  assert.deepEqual(s.points[3].break, { by: 'claude', reason: 'needed a Vercel setting', ended: 3 });
  assert.equal(s.points[0].pr, 1);
});

test('a break at the same moment as a merge comes after it; nothing at all is a streak of zero', () => {
  const s = computeStreak([merge(1, at(1))], [brk(1, at(1))]);
  assert.deepEqual(s.points.map((p) => p.value), [1, 0]);
  assert.deepEqual(computeStreak([], []), { current: 0, record: 0, record_at: null, points: [] });
});

test('a break needs a reason of 1–200 characters', () => {
  assert.deepEqual(parseStreakBreak({ reason: '  a token\nin the simulator ' }), { ok: true, reason: 'a token in the simulator' });
  for (const bad of [null, [], {}, { reason: '' }, { reason: '  ' }, { reason: 'x'.repeat(201) }, { reason: 5 }, { reason: 'a\u0000' }]) {
    assert.equal(parseStreakBreak(bad).ok, false, JSON.stringify(bad));
  }
});

test('the base branch is playground unless set', () => {
  assert.equal(streakBase({}), 'playground');
  assert.equal(streakBase({ TRIALOG_STREAK_BASE: 'main' }), 'main');
  assert.equal(streakBase({ TRIALOG_STREAK_BASE: 'a b' }), 'playground');
});

const pretendGitHub = (pages: unknown[][], status = 200) => {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status });
  }) as unknown as typeof fetch;
  return { impl, asked };
};

test('merges are read from GitHub page by page, closed-but-not-merged left out, oldest first', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: 200 - i, title: 't', merged_at: at(10, i % 60) }));
  const { impl, asked } = pretendGitHub([full, [{ number: 3, title: 'x', merged_at: at(0) }, { number: 4, title: 'closed', merged_at: null }]]);
  const merges = await fetchMerges('owner/repo', 'playground', impl);
  assert.equal(merges.length, 101);
  assert.equal(merges[0].number, 3);
  assert.equal(asked.length, 2);
  assert.match(asked[0], /^https:\/\/api\.github\.com\/repos\/owner\/repo\/pulls\?state=closed&base=playground&per_page=100&page=1$/);
});

beforeEach(() => clearStreakCache());

test('the list is cached for five minutes, and on a failure the last good list is kept', async () => {
  const good = pretendGitHub([[{ number: 1, title: 'a', merged_at: at(1) }]]);
  const t0 = Date.parse(at(12));
  assert.equal((await cachedMerges('o/r', 'playground', t0, good.impl)).merges.length, 1);
  await cachedMerges('o/r', 'playground', t0 + 60_000, good.impl);
  assert.equal(good.asked.length, 1, 'cached');
  const down = pretendGitHub([], 503);
  const later = await cachedMerges('o/r', 'playground', t0 + 6 * 60_000, down.impl);
  assert.equal(later.merges.length, 1);
  assert.match(later.problem ?? '', /GitHub answered 503\)\. Showing the last list\./);
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

test('both stores keep breaks in order, and the table refuses what is not a break', async () => {
  const memory = createMemoryStore();
  const pg = new PGlite();
  const sql = createSqlStore(pgliteDb(pg));
  await sql.ensure();
  for (const store of [memory, sql]) {
    await store.addStreakBreak({ participant: 'david', reason: 'first' });
    await store.addStreakBreak({ participant: 'grok', reason: 'second' });
    assert.deepEqual((await store.listStreakBreaks()).map((b) => [b.participant, b.reason]), [['david', 'first'], ['grok', 'second']]);
  }
  await assert.rejects(sql.addStreakBreak({ participant: 'Not A Name', reason: 'x' }));
  await assert.rejects(sql.addStreakBreak({ participant: 'david', reason: '' }));
  await assert.rejects(sql.addStreakBreak({ participant: 'david', reason: 'x'.repeat(201) }));
});

const TOKENS: Record<string, string> = { david: 'david-streak-token-0123456789abcdef', claude: 'claude-streak-token-0123456789abcd', grok: 'grok-streak-token-0123456789abcdef' };
type Handler = (request: Request) => Promise<Response>;
let streakRoute: { GET: Handler };
let breakRoute: { POST: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.TRIALOG_REPO;
  process.env.DAVID_TOKEN = TOKENS.david;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.GROK_TOKEN = TOKENS.grok;
  console.warn = () => {};
  streakRoute = (await import('../app/api/streak/route')) as unknown as typeof streakRoute;
  breakRoute = (await import('../app/api/streak/break/route')) as unknown as typeof breakRoute;
});

test('API: a token is needed; a break is the caller\'s own; without a repository the report says why', async () => {
  const get = (who?: string) => streakRoute.GET(new Request('http://hub.test/api/streak', { headers: who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {} }));
  const post = (who: string | undefined, body: unknown) => breakRoute.POST(new Request('http://hub.test/api/streak/break', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {}) }, body: JSON.stringify(body),
  }));
  assert.equal((await get()).status, 401);
  assert.equal((await post(undefined, { reason: 'x' })).status, 401);
  assert.equal((await post('claude', {})).status, 400);
  const res = await post('claude', { reason: 'needed the orchestrator to set a secret', participant: 'david' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { break: StreakBreak }).break.participant, 'claude');
  const report = (await (await get('david')).json()) as StreakReport;
  assert.equal(report.repo, null);
  assert.match(report.problem ?? '', /TRIALOG_REPO/);
  assert.equal(report.points.length, 1);
  assert.equal(report.points[0].break?.by, 'claude');
});
