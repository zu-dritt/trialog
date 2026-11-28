// Today's merged-PR count: midnight Europe/Zurich, every base branch, one GitHub page, a token-aware cache, and the API.
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  clearPrsTodayCache, countMergesOnDay, dayInZone, loadPrsToday, prsTodayCacheMs,
  prsTodayLabel, recentMergesUrl, PRS_TODAY_CACHE_MS, PRS_TODAY_CACHE_MS_NO_TOKEN, PRS_TODAY_GOAL,
  type PrsTodayReport,
} from '../lib/prs-today';
import { type Merge } from '../lib/streak';

const merge = (number: number, merged_at: string, title = `PR ${number}`): Merge => ({ number, title, merged_at });

const pretendGitHub = (rows: unknown[], status = 200) => {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify(rows), { status });
  }) as unknown as typeof fetch;
  return { impl, asked };
};

test('the chip says «PRs today: 28/100» for merges since midnight Europe/Zurich', () => {
  // 28 November 2026 is a CET day: midnight Zurich is 23:00 UTC the evening before.
  const now = Date.parse('2026-11-28T10:36:00Z');
  assert.equal(dayInZone(now), '2026-11-28');
  const merges = [
    merge(116, '2026-11-27T22:59:59Z'), // still 27 November in Zurich: does not count
    merge(117, '2026-11-27T23:00:00Z'), // exactly midnight Zurich, on the 28th, into test
    merge(118, '2026-11-28T03:46:31Z'), // into main
    ...Array.from({ length: 26 }, (_, i) => merge(119 + i, `2026-11-28T0${Math.min(9, i)}:00:00Z`)),
  ];
  assert.equal(countMergesOnDay(merges, now), 28);
  assert.equal(prsTodayLabel(28), 'PRs today: 28/100');
  assert.equal(PRS_TODAY_GOAL, 100);
});

test('a merge just before midnight Zurich is yesterday; summer time is also midnight Zurich', () => {
  const winter = Date.parse('2026-11-28T00:00:00+01:00');
  assert.equal(dayInZone(winter), '2026-11-28');
  assert.equal(countMergesOnDay([merge(1, '2026-11-27T22:59:59Z')], winter), 0);
  assert.equal(countMergesOnDay([merge(1, '2026-11-27T23:00:00Z')], winter), 1);
  // 15 July 2026 is CEST (UTC+2): midnight Zurich is 22:00 UTC the evening before.
  const summer = Date.parse('2026-07-15T08:00:00Z');
  assert.equal(dayInZone(summer), '2026-07-15');
  assert.equal(countMergesOnDay([merge(1, '2026-07-14T21:59:59Z')], summer), 0);
  assert.equal(countMergesOnDay([merge(1, '2026-07-14T22:00:00Z')], summer), 1);
});

test('an invalid merged_at is skipped, and zero merges is a count of zero', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(countMergesOnDay([merge(1, 'not-a-date'), merge(2, '2026-11-28T10:00:00Z')], now), 1);
  assert.equal(countMergesOnDay([], now), 0);
});

beforeEach(() => clearPrsTodayCache());

test('loadPrsToday asks one page sorted by updated, counts every base, and has no count when GitHub cannot be read', async () => {
  const rows = [
    { number: 117, title: 'v0.3 to test', merged_at: '2026-11-28T03:46:13Z', head: { ref: 'release/v0.3' } },
    { number: 118, title: 'v0.3 to main', merged_at: '2026-11-28T03:46:31Z', head: { ref: 'release/v0.3' } },
    { number: 145, title: 'Next line', merged_at: '2026-11-28T10:37:05Z', head: { ref: 'claude/next-why' } },
    { number: 90, title: 'closed, not merged', merged_at: null, head: { ref: 'x' } },
  ];
  // A full first page would previously have caused a second request. This path stops after page 1.
  const full = Array.from({ length: 100 }, (_, i) => rows[i] ?? { number: 1000 + i, title: 'older', merged_at: '2026-11-27T10:00:00Z', head: { ref: 'old' } });
  const github = pretendGitHub(full);
  const now = Date.parse('2026-11-28T11:00:00Z');
  const env = { TRIALOG_REPO: 'zu-dritt/trialog' };
  const first = await loadPrsToday(now, github.impl, env);
  assert.deepEqual({ count: first.count, goal: first.goal, day: first.day, repo: first.repo, problem: first.problem }, {
    count: 3, goal: 100, day: '2026-11-28', repo: 'zu-dritt/trialog', problem: null,
  });
  assert.equal(github.asked.length, 1, 'one page only, even when that page is full');
  assert.equal(github.asked[0], recentMergesUrl('zu-dritt/trialog'));
  assert.match(github.asked[0], /sort=updated&direction=desc/);
  assert.doesNotMatch(github.asked[0], /base=/);
  assert.doesNotMatch(github.asked[0], /page=2/);

  const down = pretendGitHub([], 503);
  const stale = await loadPrsToday(now + PRS_TODAY_CACHE_MS_NO_TOKEN, down.impl, env);
  assert.equal(stale.count, 3, 'the last good list is still counted');
  assert.match(stale.problem ?? '', /GitHub answered 503/);

  clearPrsTodayCache();
  const empty = await loadPrsToday(now, down.impl, env);
  assert.equal(empty.count, null, 'no last list: there is no count, so the chip hides');
  assert.match(empty.problem ?? '', /GitHub answered 503/);
});

test('the cache is five minutes without a GitHub token, and one minute with one', async () => {
  const rows = [{ number: 1, title: 'today', merged_at: '2026-11-28T10:00:00Z', head: { ref: 'x' } }];
  const now = Date.parse('2026-11-28T11:00:00Z');
  assert.equal(prsTodayCacheMs({}), PRS_TODAY_CACHE_MS_NO_TOKEN);
  assert.equal(prsTodayCacheMs({ TRIALOG_GITHUB_TOKEN: '  abc  ' }), PRS_TODAY_CACHE_MS);

  const noToken = pretendGitHub(rows);
  const env = { TRIALOG_REPO: 'owner/repo' };
  await loadPrsToday(now, noToken.impl, env);
  await loadPrsToday(now + PRS_TODAY_CACHE_MS, noToken.impl, env);
  assert.equal(noToken.asked.length, 1, 'still cached at one minute without a token');
  await loadPrsToday(now + PRS_TODAY_CACHE_MS_NO_TOKEN - 1, noToken.impl, env);
  assert.equal(noToken.asked.length, 1, 'still cached just before five minutes');
  await loadPrsToday(now + PRS_TODAY_CACHE_MS_NO_TOKEN, noToken.impl, env);
  assert.equal(noToken.asked.length, 2, 'refetched at five minutes without a token');

  clearPrsTodayCache();
  const withToken = pretendGitHub(rows);
  const authed = { ...env, TRIALOG_GITHUB_TOKEN: 'github-read-token-0123' };
  await loadPrsToday(now, withToken.impl, authed);
  await loadPrsToday(now + PRS_TODAY_CACHE_MS - 1, withToken.impl, authed);
  assert.equal(withToken.asked.length, 1, 'still cached just before one minute with a token');
  await loadPrsToday(now + PRS_TODAY_CACHE_MS, withToken.impl, authed);
  assert.equal(withToken.asked.length, 2, 'refetched at one minute with a token');
});

test('without TRIALOG_REPO there is no count and GitHub is not asked', async () => {
  const github = pretendGitHub([{ number: 1, title: 'x', merged_at: '2026-11-28T10:00:00Z' }]);
  const report = await loadPrsToday(Date.parse('2026-11-28T12:00:00Z'), github.impl, {});
  assert.equal(report.count, null);
  assert.match(report.problem ?? '', /TRIALOG_REPO/);
  assert.equal(github.asked.length, 0);
});

const TOKENS = { ana: 'ana-prs-today-token-0123456789ab' };
type Handler = (request: Request) => Promise<Response>;
let getRoute: Handler;
const githubCalls: string[] = [];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.PARTICIPANTS = 'ana:human:Ana,scout:agent';
  process.env.ANA_TOKEN = TOKENS.ana;
  process.env.SCOUT_TOKEN = 'scout-prs-today-token-0123456';
  process.env.TRIALOG_REPO = 'owner/repo';
  (globalThis as { __collabHubStore?: unknown }).__collabHubStore = undefined;
  clearPrsTodayCache();
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
    githubCalls.push(url);
    return new Response(JSON.stringify([
      { number: 10, title: 'today, playground', merged_at: '2026-11-28T08:00:00Z', head: { ref: 'x/a' } },
      { number: 9, title: 'today, main', merged_at: '2026-11-28T07:00:00Z', head: { ref: 'x/b' } },
      { number: 8, title: 'yesterday Zurich', merged_at: '2026-11-27T22:00:00Z', head: { ref: 'x/c' } },
    ]), { status: 200 });
  });
  ({ GET: getRoute } = (await import('../app/api/prs-today/route')) as unknown as { GET: Handler });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const name of ['PARTICIPANTS', 'ANA_TOKEN', 'SCOUT_TOKEN', 'TRIALOG_REPO']) delete process.env[name];
  clearPrsTodayCache();
});

test('GET /api/prs-today needs a token, and answers today\'s count', async () => {
  assert.equal((await getRoute(new Request('http://hub.test/api/prs-today'))).status, 401);
  vi.useFakeTimers({ now: Date.parse('2026-11-28T11:00:00Z') });
  try {
    const res = await getRoute(new Request('http://hub.test/api/prs-today', { headers: { Authorization: `Bearer ${TOKENS.ana}` } }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as PrsTodayReport;
    assert.deepEqual(body, { count: 2, goal: 100, day: '2026-11-28', repo: 'owner/repo', problem: null });
    assert.ok(githubCalls.some((u) => u === recentMergesUrl('owner/repo')));
  } finally {
    vi.useRealTimers();
  }
});
