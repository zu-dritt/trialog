// GET /api/guard and the hub's notice, through the real routes on the in-memory store.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { Message } from '../lib/core';
import type { GuardReport } from '../lib/guard';
import { resetWakeupForTests } from '../lib/webhook';

const TOKENS = {
  ana: 'ana-guard-token-0123456789abc',
  scout: 'scout-guard-token-0123456789a',
  quill: 'quill-guard-token-0123456789a',
};
const BASE = 'http://hub.test';
type Handler = (request: Request) => Promise<Response>;
let messagesPost: Handler;
let messagesGet: Handler;
let guardGet: Handler;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.PARTICIPANTS = 'ana:human,scout:agent,quill:agent';
  process.env.ANA_TOKEN = TOKENS.ana;
  process.env.SCOUT_TOKEN = TOKENS.scout;
  process.env.QUILL_TOKEN = TOKENS.quill;
  process.env.GUARD_IN_A_ROW = '3';
  process.env.GUARD_PER_HOUR = 'not a number';
  (globalThis as { __collabHubStore?: unknown }).__collabHubStore = undefined;
  resetWakeupForTests();
  ({ POST: messagesPost, GET: messagesGet } = (await import('../app/api/messages/route')) as unknown as { POST: Handler; GET: Handler });
  ({ GET: guardGet } = (await import('../app/api/guard/route')) as unknown as { GET: Handler });
});
afterAll(() => {
  for (const name of ['PARTICIPANTS', 'ANA_TOKEN', 'SCOUT_TOKEN', 'QUILL_TOKEN', 'GUARD_IN_A_ROW', 'GUARD_PER_HOUR']) delete process.env[name];
  resetWakeupForTests();
});

const auth = (who: keyof typeof TOKENS) => ({ Authorization: `Bearer ${TOKENS[who]}` });
const post = (who: keyof typeof TOKENS, text: string, room?: string) => messagesPost(new Request(`${BASE}/api/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: JSON.stringify({ text, ...(room ? { room } : {}) }),
}));
const guard = async (who: keyof typeof TOKENS = 'scout') => (await (await guardGet(new Request(`${BASE}/api/guard`, { headers: auth(who) }))).json()) as GuardReport;
const hubMessages = async () => ((await (await messagesGet(new Request(`${BASE}/api/messages`, { headers: auth('ana') }))).json()) as { messages: Message[] })
  .messages.filter((m) => m.sender === 'hub');

test('GET /api/guard needs a token', async () => {
  assert.equal((await guardGet(new Request(`${BASE}/api/guard`))).status, 401);
});

test('three agent messages in a row trip the guard once; the hub says so to the human; a human message lifts it', async () => {
  const start = await guard('ana');
  assert.deepEqual(start.limits, { perHour: 60, inARow: 3, perDay: 300 }, 'an unusable setting is the default');
  assert.equal(start.tripped, null);
  assert.equal(start.hours.length, 24);
  assert.deepEqual(Object.keys(start.hours[23].bySender), ['scout', 'quill']);

  await post('ana', 'start');
  for (const [who, text] of [['scout', 'one'], ['quill', 'two'], ['scout', 'three'], ['quill', 'four']] as const) {
    assert.equal((await post(who, text)).status, 201, 'posting is never refused');
  }
  const notices = (await hubMessages()).filter((m) => m.text.startsWith('Guard:'));
  assert.deepEqual(notices.map((m) => [m.recipient, m.text]), [['ana', 'Guard: wake-ups paused, 3 agent messages in a row without a human. Write anything to continue.']]);

  const tripped = await guard();
  assert.equal(tripped.tripped, 'in-a-row');
  assert.equal(tripped.now.inARow, 4);
  assert.equal(tripped.now.day, start.now.day + 4);
  assert.equal(tripped.pausesToday, start.pausesToday + 1);
  const thisHour = tripped.hours[23].bySender;
  assert.ok(thisHour.scout >= 2 && thisHour.quill >= 2);

  await post('ana', 'go on');
  const lifted = await guard();
  assert.equal(lifted.tripped, null);
  assert.equal(lifted.now.inARow, 0);
});
