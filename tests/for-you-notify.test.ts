// The 08:00 push (slice 2 of playground #1464): POST /api/for-you/notify sends the caller their own
// list, only when it isn't empty, and never lets an agent push a human.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { getStore } from '../lib/store';

const TOKENS: Record<string, string> = {
  grok: 'grok-foryou-token-0123456789abcdef',
  claude: 'claude-foryou-token-0123456789abcd',
  david: 'david-foryou-token-0123456789abcdef',
};

type Handler = (request: Request) => Promise<Response>;
let notify: { POST: Handler };
let list: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.APNS_KEY_P8;
  delete process.env.TRIALOG_REPO;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  notify = (await import('../app/api/for-you/notify/route')) as unknown as typeof notify;
  list = (await import('../app/api/for-you/route')) as unknown as typeof list;
});

const post = (who?: string) => notify.POST(new Request('http://hub/api/for-you/notify', { method: 'POST', headers: who ? { Authorization: `Bearer ${TOKENS[who]}` } : {} }));

test('no token: 401; an agent: 403, so nobody can push someone else', async () => {
  assert.equal((await post()).status, 401);
  const res = await post('grok');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /only their own/);
});

test('an empty list sends nothing; with something waiting, the list goes out (no APNs key here, so no device takes it)', async () => {
  assert.deepEqual(await (await post('david')).json(), { sent: false, items: 0, devices: 0 });
  const store = await getStore();
  await store.setFlight({ participant: 'grok', state: 'waiting', text: 'David: merge PR 160' });
  assert.deepEqual(await (await post('david')).json(), { sent: false, items: 1, devices: 0 });
  const { items } = await (await list.GET(new Request('http://hub/api/for-you', { headers: { Authorization: `Bearer ${TOKENS.david}` } }))).json();
  assert.deepEqual(items.map((i: { key: string }) => i.key), ['flight-grok']);
});
