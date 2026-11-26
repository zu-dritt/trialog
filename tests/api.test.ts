// Calls the real route handlers with Web Request objects (memory store, test tokens).
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { Message } from '../lib/core';

const TOKENS: Record<string, string> = {
  grok: 'grok-test-token-0123456789abcdef',
  claude: 'claude-test-token-0123456789abcdef',
  david: 'david-test-token-0123456789abcdef',
};

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let messages: { GET: Handler; POST: Handler };
let pin: { POST: Handler };
let exportRoute: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {}; // silence the in-memory store warning
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  pin = (await import('../app/api/messages/[id]/pin/route')) as unknown as typeof pin;
  exportRoute = (await import('../app/api/export/route')) as unknown as typeof exportRoute;
});

const URL_BASE = 'http://hub.test';
const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const get = (path: string, who?: string) => messages.GET(new Request(URL_BASE + path, { headers: auth(who) }));
const post = (body: unknown, who?: string, raw?: string) => messages.POST(new Request(`${URL_BASE}/api/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth(who) },
  body: raw ?? JSON.stringify(body),
}));
const posted = async (body: unknown, who: string) => ((await (await post(body, who)).json()) as { message: Message }).message;

test('missing or wrong tokens are rejected on every endpoint', async () => {
  for (const who of [undefined, 'not-a-real-token-0123456789']) {
    assert.equal((await get('/api/messages', who)).status, 401);
    assert.equal((await post({ text: 'hi' }, who)).status, 401);
    const p = await pin.POST(new Request(`${URL_BASE}/api/messages/1/pin`, { method: 'POST', headers: auth(who), body: '{"pinned":true}' }), { params: Promise.resolve({ id: '1' }) });
    assert.equal(p.status, 401);
    assert.equal((await exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth(who) }))).status, 401);
  }
  const all = (await (await get('/api/messages', 'david')).json()) as { messages: Message[] };
  assert.ok(all.messages.every((m) => m.text !== 'hi'), 'nothing was stored');
});

test('the sender comes from the token, never from the body', async () => {
  const res = await post({ text: 'I am totally David', sender: 'david', from: 'david' }, 'grok');
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.equal(message.sender, 'grok');
  const me = (await (await get('/api/messages?limit=1', 'claude')).json()) as { me: string };
  assert.equal(me.me, 'claude');
});

test('post and read: addressing, since, DECISION pin, export', async () => {
  const a = await posted({ text: '@claude please check the PR' }, 'grok');
  assert.equal(a.recipient, 'claude');
  const b = await posted({ text: 'DECISION: ship v1 today', to: 'grok' }, 'david');
  assert.ok(b.pinned_at);
  assert.equal(b.recipient, 'grok');

  const since = (await (await get(`/api/messages?since=${a.id}`, 'claude')).json()) as { messages: Message[]; pinned: Message[] };
  assert.deepEqual(since.messages.map((m) => m.id), [b.id]);
  assert.ok(since.pinned.some((m) => m.id === b.id));

  const forClaude = (await (await get('/api/messages?since=0&to=claude', 'claude')).json()) as { messages: Message[] };
  assert.ok(forClaude.messages.every((m) => m.recipient === 'claude'));

  const md = await (await exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth('david') }))).text();
  assert.match(md, /## Decisions/);
  assert.match(md, /DECISION: ship v1 today/);
});

test('pin and unpin through the API', async () => {
  const m = await posted({ text: 'pin me' }, 'claude');
  const call = (body: unknown, id = String(m.id)) => pin.POST(
    new Request(`${URL_BASE}/api/messages/${id}/pin`, { method: 'POST', headers: auth('david'), body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  const pins = async (res: Response) => ((await res.json()) as { pinned: Message[] }).pinned;
  const listed = await pins(await call({ pinned: true }));
  const pinned = listed.find((p) => p.id === m.id);
  assert.ok(pinned);
  assert.equal(pinned.pin_title, null);

  const named = await call({ pinned: true, title: 'Roadmap board' });
  assert.equal(named.status, 200);
  const namedBody = (await named.json()) as { message: Message; pinned: Message[] };
  assert.equal(namedBody.message.pin_title, 'Roadmap board');
  assert.equal(namedBody.pinned.find((p) => p.id === m.id)?.pin_title, 'Roadmap board');

  const renamed = await call({ title: 'How to give feedback' });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as { message: Message }).message.pin_title, 'How to give feedback');

  const unpinned = await pins(await call({ pinned: false }));
  assert.ok(!unpinned.some((p) => p.id === m.id));
  assert.equal((await call({ title: 'Too soon' })).status, 400, 'a title on an unpinned message');
  const again = await call({ pinned: true });
  assert.equal(((await again.json()) as { message: Message }).message.pin_title, null, 'unpinning clears the title');
  assert.equal((await call({ pinned: true }, '999999')).status, 404);
  assert.equal((await call({ pinned: 'yes' })).status, 400);
  assert.equal((await call({ pinned: true, title: '' })).status, 400);
  assert.equal((await call({ pinned: true, title: 'x'.repeat(81) })).status, 400);
  assert.equal((await call({ pinned: false, title: 'nope' })).status, 400);
});

test('bad input is rejected with clear errors', async () => {
  assert.equal((await post(null, 'grok', 'not json')).status, 400);
  assert.equal((await post({ text: '' }, 'grok')).status, 400);
  assert.equal((await post({ text: 'x', to: 'mallory' }, 'grok')).status, 400);
  assert.equal((await post({ text: 'x'.repeat(20 * 1024 + 1) }, 'grok')).status, 413);
  assert.equal((await post(null, 'grok', JSON.stringify({ text: 'x', pad: 'y'.repeat(40 * 1024) }))).status, 413);
  assert.equal((await get('/api/messages?since=abc', 'grok')).status, 400);
  assert.equal((await get('/api/messages?to=mallory', 'grok')).status, 400);
});

test('posts are rate-limited to 30 per minute per sender', async () => {
  // Claude has posted once above ("pin me"); fill up to 30.
  const list = (await (await get('/api/messages?since=0', 'claude')).json()) as { messages: Message[] };
  const before = list.messages.filter((m) => m.sender === 'claude').length;
  for (let i = before; i < 30; i++) assert.equal((await post({ text: `flood ${i}` }, 'claude')).status, 201);
  const limited = await post({ text: 'one too many' }, 'claude');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await post({ text: 'David is not affected' }, 'david')).status, 201);
});
