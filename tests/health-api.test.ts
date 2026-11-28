// GET /api/health through the real route on the in-memory store, with GitHub pretended.
import { afterAll, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { HealthReport } from '../lib/health';
import { clearStreakCache } from '../lib/streak';

const TOKENS = { ana: 'ana-health-token-0123456789abc', scout: 'scout-health-token-0123456789a', quill: 'quill-health-token-0123456789a' };
const BASE = 'http://hub.test';
type Handler = (request: Request) => Promise<Response>;
let healthGet: Handler;
let flightPut: Handler;
let messagesPost: Handler;
const github: { url: string; ok: boolean }[] = [];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.PARTICIPANTS = 'ana:human:Ana,scout:agent,quill:agent';
  process.env.ANA_TOKEN = TOKENS.ana;
  process.env.SCOUT_TOKEN = TOKENS.scout;
  process.env.QUILL_TOKEN = TOKENS.quill;
  process.env.TRIALOG_REPO = 'owner/repo';
  (globalThis as { __collabHubStore?: unknown }).__collabHubStore = undefined;
  clearStreakCache();
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
    github.push({ url, ok: true });
    return new Response(JSON.stringify([
      { number: 9, title: 'Scout work', merged_at: '2026-11-28T07:48:02Z', head: { ref: 'scout/work' } },
      { number: 8, title: 'Quill work', merged_at: '2026-11-28T06:58:54Z', head: { ref: 'quill/other' } },
      { number: 7, title: 'closed unmerged', merged_at: null, head: { ref: 'quill/x' } },
    ]), { status: 200 });
  });
  ({ GET: healthGet } = (await import('../app/api/health/route')) as unknown as { GET: Handler });
  ({ PUT: flightPut } = (await import('../app/api/flight/route')) as unknown as { PUT: Handler });
  ({ POST: messagesPost } = (await import('../app/api/messages/route')) as unknown as { POST: Handler });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const name of ['PARTICIPANTS', 'ANA_TOKEN', 'SCOUT_TOKEN', 'QUILL_TOKEN', 'TRIALOG_REPO']) delete process.env[name];
  clearStreakCache();
});

const auth = (who: keyof typeof TOKENS) => ({ Authorization: `Bearer ${TOKENS[who]}`, 'Content-Type': 'application/json' });
const flight = (who: keyof typeof TOKENS, state: string, text: string) => flightPut(new Request(`${BASE}/api/flight`, { method: 'PUT', headers: auth(who), body: JSON.stringify({ state, text }) }));
const health = async () => (await (await healthGet(new Request(`${BASE}/api/health`, { headers: auth('ana') }))).json()) as HealthReport;

test('it needs a token', async () => {
  assert.equal((await healthGet(new Request(`${BASE}/api/health`))).status, 401);
});

test('before anyone says anything: both agents are there, resting and grey; the human has no chip', async () => {
  const r = await health();
  assert.deepEqual(r.agents.map((a) => [a.participant, a.word, a.heartbeat, a.blocked]), [['scout', 'resting', 'grey', null], ['quill', 'resting', 'grey', null]]);
});

test('a flight turns the heartbeat green and sets the word; a wait on the human blocks; last merge comes from the branch', async () => {
  await flight('scout', 'working', 'Reviewing PR 12');
  await flight('quill', 'waiting', 'Ana: merge PR 13');
  const r = await health();
  const [scout, quill] = r.agents;
  assert.deepEqual([scout.word, scout.heartbeat, scout.text, scout.blocked], ['reviewing', 'green', 'Reviewing PR 12', null]);
  assert.deepEqual([quill.word, quill.heartbeat, quill.blocked?.on, quill.blocked?.text], ['waiting', 'green', 'Ana', 'merge PR 13']);
  assert.ok(scout.heard_ago_ms !== null && scout.heard_ago_ms < 60_000);
  assert.deepEqual(scout.last_merge, { pr: 9, merged_at: '2026-11-28T07:48:02Z' });
  assert.deepEqual(quill.last_merge, { pr: 8, merged_at: '2026-11-28T06:58:54Z' }, 'an unmerged PR does not count');
});

test('a message is a sign of life, and a wait on a merged PR is not a block', async () => {
  await flight('quill', 'waiting', 'Ana: merge PR 8');
  const before = await health();
  assert.equal(before.agents[1].blocked, null, 'PR 8 is merged on the base branch: the wait is over');
  const sent = await messagesPost(new Request(`${BASE}/api/messages`, { method: 'POST', headers: auth('quill'), body: JSON.stringify({ text: 'still here' }) }));
  assert.equal(sent.status, 201);
  assert.equal((await health()).agents[1].heartbeat, 'green');
  assert.ok(github.length >= 1, 'GitHub was asked for merges');
});
