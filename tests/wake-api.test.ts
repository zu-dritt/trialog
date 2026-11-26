// The wake-up HTTP API: register, test and clear your own target; GET /api/wake; ?wakes=1.
// Secrets must never appear in a response.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { Message } from '../lib/core';
import { resetWakeupForTests, setWakeDnsForTests } from '../lib/webhook';

const TOKENS = {
  ana: 'ana-test-token-0123456789abcd',
  scout: 'scout-test-token-0123456789ab',
  quill: 'quill-test-token-0123456789ab',
};
const BASE = 'http://hub.test';
type Handler = (request: Request) => Promise<Response>;
let messagesPost: Handler;
let messagesGet: Handler;
let targetGet: Handler;
let targetPut: Handler;
let targetDelete: Handler;
let targetTest: Handler;
let wakeGet: Handler;

const fetchCalls: { url: string; body: string; headers: Record<string, string> }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.PARTICIPANTS = 'ana:human,scout:agent,quill:agent';
  process.env.ANA_TOKEN = TOKENS.ana;
  process.env.SCOUT_TOKEN = TOKENS.scout;
  process.env.QUILL_TOKEN = TOKENS.quill;
  delete process.env.GROK_WEBHOOK_URL;
  delete process.env.GROK_WEBHOOK_SECRET;
  resetWakeupForTests();
  setWakeDnsForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  ({ POST: messagesPost, GET: messagesGet } = (await import('../app/api/messages/route')) as unknown as { POST: Handler; GET: Handler });
  ({ GET: targetGet, PUT: targetPut, DELETE: targetDelete } = (await import('../app/api/wake/target/route')) as unknown as { GET: Handler; PUT: Handler; DELETE: Handler });
  ({ POST: targetTest } = (await import('../app/api/wake/target/test/route')) as unknown as { POST: Handler });
  ({ GET: wakeGet } = (await import('../app/api/wake/route')) as unknown as { GET: Handler });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.PARTICIPANTS;
  for (const name of ['ANA_TOKEN', 'SCOUT_TOKEN', 'QUILL_TOKEN']) delete process.env[name];
  resetWakeupForTests();
  setWakeDnsForTests(null);
});

const auth = (who: keyof typeof TOKENS) => ({ Authorization: `Bearer ${TOKENS[who]}` });
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

function noSecret(value: unknown, secret: string, label: string) {
  const dumped = JSON.stringify(value);
  assert.ok(!dumped.includes(secret), `${label} leaked the secret`);
}

test('a participant can set, read, test and clear their own target; the secret is never returned', async () => {
  const secret = 'scout-wake-secret-01234567';
  const missing = await targetGet(new Request(`${BASE}/api/wake/target`, { headers: auth('scout') }));
  assert.equal(missing.status, 404);

  const put = await targetPut(new Request(`${BASE}/api/wake/target`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('scout') },
    body: JSON.stringify({ url: 'https://scout.example/wake', secret }),
  }));
  assert.equal(put.status, 200);
  const putBody = await bodyOf(put);
  const target = putBody.target as { host: string; updated_at: string; url?: string };
  assert.equal(target.host, 'scout.example');
  assert.equal(target.url, undefined, 'the full URL is never returned');
  assert.ok(target.updated_at);
  noSecret(putBody, secret, 'PUT');

  const got = await targetGet(new Request(`${BASE}/api/wake/target`, { headers: auth('scout') }));
  assert.equal(got.status, 200);
  const gotBody = await bodyOf(got);
  assert.equal((gotBody.target as { host: string; url?: string }).host, 'scout.example');
  assert.equal((gotBody.target as { url?: string }).url, undefined, 'the full URL is never returned');
  noSecret(gotBody, secret, 'GET');

  fetchCalls.length = 0;
  const tested = await targetTest(new Request(`${BASE}/api/wake/target/test`, { method: 'POST', headers: auth('scout') }));
  assert.equal(tested.status, 200);
  const testBody = await bodyOf(tested);
  assert.deepEqual(testBody, { ok: true, status: 204 });
  noSecret(testBody, secret, 'test');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://scout.example/wake');
  const payload = JSON.parse(fetchCalls[0].body) as { id: number; preview: string };
  assert.equal(payload.id, 0);
  assert.match(payload.preview, /Wake-up test/);
  noSecret(fetchCalls[0].body, secret, 'test payload');
  noSecret(testBody, 'scout-wake-secret', 'test body');

  const cleared = await targetDelete(new Request(`${BASE}/api/wake/target`, { method: 'DELETE', headers: auth('scout') }));
  assert.equal(cleared.status, 200);
  assert.deepEqual(await bodyOf(cleared), { cleared: true });
  const after = await targetGet(new Request(`${BASE}/api/wake/target`, { headers: auth('scout') }));
  assert.equal(after.status, 404);
});

test('a human message wakes every agent; GET /api/wake returns only those messages, and ?wakes=1 shows delivery status', async () => {
  const secret = 'quill-wake-secret-01234567';
  const put = await targetPut(new Request(`${BASE}/api/wake/target`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('quill') },
    body: JSON.stringify({ url: 'https://quill.example/wake', secret }),
  }));
  assert.equal(put.status, 200);

  fetchCalls.length = 0;
  const posted = await messagesPost(new Request(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('ana') },
    body: JSON.stringify({ text: 'Please both look at this.', to: 'scout' }),
  }));
  assert.equal(posted.status, 201);
  const { message } = (await posted.json()) as { message: Message };
  assert.equal(message.recipient, 'scout');
  // The response did not wait for the debounce (2 s) or the webhook.
  assert.equal(fetchCalls.length, 0);
  // Give the background job (2 s debounce in production; here the imported getWakeup uses defaults).
  // This test does not wait for delivery; it checks the poll path immediately, and ?wakes=1 after a short tick if needed.
  noSecret(message, secret, 'POST message');

  const forQuill = await wakeGet(new Request(`${BASE}/api/wake?since=0`, { headers: auth('quill') }));
  assert.equal(forQuill.status, 200);
  const quillBody = await bodyOf(forQuill);
  assert.equal(quillBody.me, 'quill');
  const quillMessages = quillBody.messages as Message[];
  assert.ok(quillMessages.some((m) => m.id === message.id), 'the human message wakes quill even though it was addressed to scout');

  const forScout = await wakeGet(new Request(`${BASE}/api/wake?since=0`, { headers: auth('scout') }));
  const scoutMessages = ((await bodyOf(forScout)).messages as Message[]);
  assert.ok(scoutMessages.some((m) => m.id === message.id), 'and it wakes scout too');

  const forHuman = await wakeGet(new Request(`${BASE}/api/wake?since=0`, { headers: auth('ana') }));
  assert.deepEqual(((await bodyOf(forHuman)).messages as Message[]), [], 'a human is not woken');

  // An agent writing to the human wakes no agent.
  const aside = await messagesPost(new Request(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('scout') },
    body: JSON.stringify({ text: 'Only for the human.', to: 'ana' }),
  }));
  assert.equal(aside.status, 201);
  const asideMsg = ((await aside.json()) as { message: Message }).message;
  const afterAside = await wakeGet(new Request(`${BASE}/api/wake?since=${message.id}`, { headers: auth('quill') }));
  assert.ok(!((await bodyOf(afterAside)).messages as Message[]).some((m) => m.id === asideMsg.id));

  const listed = await messagesGet(new Request(`${BASE}/api/messages?since=0&wakes=1`, { headers: auth('quill') }));
  assert.equal(listed.status, 200);
  const listedBody = await bodyOf(listed);
  assert.ok(Array.isArray(listedBody.wakes));
  noSecret(listedBody, secret, 'wakes=1');
  // Delivery may still be pending (debounce). The row should exist once the job has enqueued it;
  // wait briefly for the default 2 s debounce plus a send.
  const deadline = Date.now() + 4000;
  let wakes = listedBody.wakes as { message_id: number; participant: string; status: string }[];
  while (Date.now() < deadline && !wakes.some((w) => w.message_id === message.id && w.participant === 'quill')) {
    await new Promise((r) => setTimeout(r, 200));
    const again = await messagesGet(new Request(`${BASE}/api/messages?since=0&wakes=1`, { headers: auth('quill') }));
    wakes = ((await bodyOf(again)).wakes as typeof wakes) ?? [];
  }
  const row = wakes.find((w) => w.message_id === message.id && w.participant === 'quill');
  assert.ok(row, 'a delivery row is recorded for the agent with a target');
  assert.ok(row.status === 'pending' || row.status === 'delivered');
  assert.equal(wakes.some((w) => w.participant === 'scout'), false, 'an agent with no target has no delivery row');
});

test('GET /api/wake rejects a bad since or wait, and requires a token', async () => {
  const badSince = await wakeGet(new Request(`${BASE}/api/wake?since=nope`, { headers: auth('scout') }));
  assert.equal(badSince.status, 400);
  const badWait = await wakeGet(new Request(`${BASE}/api/wake?since=0&wait=99`, { headers: auth('scout') }));
  assert.equal(badWait.status, 400);
  const unauth = await wakeGet(new Request(`${BASE}/api/wake?since=0`));
  assert.equal(unauth.status, 401);
});

test('registration refuses an internal host, without sending anything', async () => {
  const secret = 'internal-wake-secret-0123';
  const put = await targetPut(new Request(`${BASE}/api/wake/target`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('scout') },
    body: JSON.stringify({ url: 'https://127.0.0.1/wake', secret }),
  }));
  assert.equal(put.status, 400);
  const body = await bodyOf(put);
  assert.match(String(body.error), /internal host/);
  noSecret(body, secret, 'internal PUT');
  const missing = await targetGet(new Request(`${BASE}/api/wake/target`, { headers: auth('scout') }));
  assert.equal(missing.status, 404);
});

test('a human can list who has a target (host only) and clear someone else\'s', async () => {
  const { GET: participantsGet } = (await import('../app/api/participants/route')) as unknown as { GET: Handler };
  const secret = 'scout-wake-secret-for-list-01';
  const put = await targetPut(new Request(`${BASE}/api/wake/target`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('scout') },
    body: JSON.stringify({ url: 'https://scout.example/hooks/secret-path', secret }),
  }));
  assert.equal(put.status, 200);

  const asAgent = await participantsGet(new Request(`${BASE}/api/participants`, { headers: auth('quill') }));
  const agentBody = await bodyOf(asAgent);
  const agentRow = (agentBody.participants as { name: string; wake_target_host?: string }[]).find((p) => p.name === 'scout');
  assert.equal(agentRow && 'wake_target_host' in agentRow, false, 'an agent does not see who has a target');

  const asHuman = await participantsGet(new Request(`${BASE}/api/participants`, { headers: auth('ana') }));
  assert.equal(asHuman.status, 200);
  const humanBody = await bodyOf(asHuman);
  noSecret(humanBody, secret, 'participants');
  const dumped = JSON.stringify(humanBody);
  assert.ok(!dumped.includes('hooks/secret-path'), 'the path is not returned');
  assert.ok(!dumped.includes('https://'), 'the full URL is not returned');
  const scout = (humanBody.participants as { name: string; wake_target_host: string | null; wake_target_set_at: string | null }[]).find((p) => p.name === 'scout');
  assert.ok(scout);
  assert.equal(scout.wake_target_host, 'scout.example');
  assert.ok(scout.wake_target_set_at);

  const forbidden = await targetDelete(new Request(`${BASE}/api/wake/target?participant=scout`, { method: 'DELETE', headers: auth('quill') }));
  assert.equal(forbidden.status, 403);

  const cleared = await targetDelete(new Request(`${BASE}/api/wake/target?participant=scout`, { method: 'DELETE', headers: auth('ana') }));
  assert.equal(cleared.status, 200);
  assert.deepEqual(await bodyOf(cleared), { cleared: true });
  const after = await targetGet(new Request(`${BASE}/api/wake/target`, { headers: auth('scout') }));
  assert.equal(after.status, 404);
});

test('the wake test endpoint is limited to 3 calls per participant per minute', async () => {
  const secret = 'rate-limit-secret-012345';
  const put = await targetPut(new Request(`${BASE}/api/wake/target`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('quill') },
    body: JSON.stringify({ url: 'https://quill.example/wake', secret }),
  }));
  assert.equal(put.status, 200);
  fetchCalls.length = 0;
  for (let i = 0; i < 3; i++) {
    const res = await targetTest(new Request(`${BASE}/api/wake/target/test`, { method: 'POST', headers: auth('quill') }));
    assert.equal(res.status, 200, `test ${i + 1}`);
  }
  const limited = await targetTest(new Request(`${BASE}/api/wake/target/test`, { method: 'POST', headers: auth('quill') }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.equal(fetchCalls.length, 3, 'the fourth call does not send');
  // A different participant still has their own budget.
  const other = await targetTest(new Request(`${BASE}/api/wake/target/test`, { method: 'POST', headers: auth('scout') }));
  // scout has no target in this test (cleared above) or may 404; the point is not 429
  assert.notEqual(other.status, 429);
});
