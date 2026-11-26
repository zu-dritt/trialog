// A message addressed to its own sender is a message to everyone. It comes about by accident
// (a message that begins with the writer's own "@name", such as a pasted line), and stored as
// written it would be for nobody else: nobody would be woken for it.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import { createMemoryStore, createSqlStore, notToSelf, wakesGrok, type Db, type Row, type Store } from '../lib/store';

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];
const must = <T>(v: T | null | undefined): T => { assert.ok(v, 'expected a value'); return v; };

test('notToSelf: only "to myself" changes', () => {
  assert.equal(notToSelf('david', 'david'), null);
  assert.equal(notToSelf('grok', 'grok'), null);
  assert.equal(notToSelf('david', 'grok'), 'grok');
  assert.equal(notToSelf('grok', 'david'), 'david');
  assert.equal(notToSelf('david', null), null);
  assert.equal(notToSelf('david', undefined), null);
  assert.equal(notToSelf('hub', 'claude'), 'claude');
});

for (const [name, make] of STORES) {
  test(`${name}: a message to its own sender is stored as a message to everyone`, async () => {
    const store = await make();
    const toSelf = must(await store.add({ sender: 'david', recipient: 'david', text: '@david a line that starts with my own name' }));
    assert.equal(toSelf.recipient, null);
    assert.equal(toSelf.sender, 'david');
    // Everyone else's addressing is untouched, in both directions.
    assert.equal(must(await store.add({ sender: 'david', recipient: 'grok', text: 'for grok' })).recipient, 'grok');
    assert.equal(must(await store.add({ sender: 'grok', recipient: 'david', text: 'for the human' })).recipient, 'david');
    assert.equal(must(await store.add({ sender: 'claude', recipient: null, text: 'for all' })).recipient, null);
    assert.equal(must(await store.add({ sender: 'claude', recipient: 'claude', text: 'to myself' })).recipient, null);

    // What was stored is what comes back, in every list.
    const all = await store.all();
    assert.equal(all.find((m) => m.id === toSelf.id)?.recipient, null);
    assert.ok(!(await store.list({ since: 0, to: 'david' })).some((m) => m.id === toSelf.id), 'it is not listed as "addressed to David"');
    assert.ok((await store.list({ since: 0 })).some((m) => m.id === toSelf.id));
  });

  test(`${name}: such a message wakes the agent like any message to everyone`, async () => {
    const store = await make();
    // Before this change it was addressed to the human alone, and nobody was woken.
    const m = must(await store.add({ sender: 'david', recipient: 'david', text: '@david pasted line' }));
    assert.equal(wakesGrok(m), true);
    assert.deepEqual(await store.claimWakeup(), { first_id: m.id, last_id: m.id, count: 1, previous_id: 0 });
    // Grok writing "to Grok" is a message to everyone too, and Grok's own messages still never wake Grok.
    const own = must(await store.add({ sender: 'grok', recipient: 'grok', text: 'note' }));
    assert.equal(own.recipient, null);
    assert.equal(wakesGrok(own), false);
    assert.equal(await store.claimWakeup(), null);
  });

  test(`${name}: a poll addressed to its own creator goes to everyone as well`, async () => {
    const store = await make();
    const mine = must(await store.createPoll({ creator: 'claude', question: 'Lunch?', options: ['Pizza', 'Salad'], recipient: 'claude' }));
    assert.equal(mine.message.recipient, null);
    const theirs = must(await store.createPoll({ creator: 'claude', question: 'Dinner?', options: ['Pizza', 'Salad'], recipient: 'grok' }));
    assert.equal(theirs.message.recipient, 'grok');
  });
}

// --- the API ------------------------------------------------------------------------------------

const TOKENS: Record<string, string> = {
  grok: 'grok-test-token-0123456789abcdef',
  claude: 'claude-test-token-0123456789abcdef',
  david: 'david-test-token-0123456789abcdef',
};
type Handler = (request: Request) => Promise<Response>;
let messages: { GET: Handler; POST: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
});

const post = async (body: unknown, who: string) => {
  const res = await messages.POST(new Request('http://hub.test/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKENS[who]}` }, body: JSON.stringify(body),
  }));
  assert.equal(res.status, 201);
  return ((await res.json()) as { message: Message }).message;
};

test('POST /api/messages: "@me" at the start, or "to": me, gives a message to everyone', async () => {
  // The case that was hit: the message began with a line that started with the writer's own name.
  assert.equal((await post({ text: '@david this line was pasted from somewhere' }, 'david')).recipient, null);
  assert.equal((await post({ text: 'explicitly to myself', to: 'david' }, 'david')).recipient, null);
  assert.equal((await post({ text: '@David: any spelling of the name', to: '@David' }, 'david')).recipient, null);
  // "DECISION:" after the writer's own name still pins.
  const pinned = await post({ text: '@claude DECISION: I decide this myself' }, 'claude');
  assert.equal(pinned.recipient, null);
  assert.ok(pinned.pinned_at);
  // The same texts from someone else are addressed as written.
  assert.equal((await post({ text: '@david this is for the human' }, 'grok')).recipient, 'david');
  assert.equal((await post({ text: 'so is this', to: 'david' }, 'claude')).recipient, 'david');
  assert.equal((await post({ text: 'and this is for everyone' }, 'david')).recipient, null);
  assert.equal((await post({ text: '@grok for grok' }, 'david')).recipient, 'grok');
});
