// Search: the rules of a query, both stores (the real SQL on PGlite and the memory store) and the route.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import { MAX_SEARCH_CHARS, MAX_SEARCH_WORDS, SEARCH_LIMIT, likePattern, parseQuery } from '../lib/search';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const must = <T>(v: T | null): T => {
  assert.ok(v, 'expected a value');
  return v;
};

test('a query is one to eight words, at most 200 characters', () => {
  const words = (q: unknown) => { const p = parseQuery(q); return p.ok ? p.words : p.error; };
  assert.deepEqual(words('storage'), ['storage']);
  assert.deepEqual(words('  which   storage\tnow\n'), ['which', 'storage', 'now']);
  // A word given twice counts once, whatever its case.
  assert.deepEqual(words('Storage storage STORAGE images'), ['Storage', 'images']);
  for (const empty of ['', '   ', '\n\t', undefined, null, 7, ['a']]) assert.match(String(words(empty)), /at least one word/);
  assert.deepEqual(words('a b c d e f g h'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.match(String(words('a b c d e f g h i')), new RegExp(`at most ${MAX_SEARCH_WORDS} words`));
  assert.equal(words('x'.repeat(MAX_SEARCH_CHARS)).length, 1);
  assert.match(String(words('x'.repeat(MAX_SEARCH_CHARS + 1))), new RegExp(`at most ${MAX_SEARCH_CHARS} characters`));
  assert.equal(SEARCH_LIMIT, 50);
});

test('a word becomes a pattern that matches only itself', () => {
  assert.equal(likePattern('storage'), '%storage%');
  assert.equal(likePattern('100%'), '%100\\%%');
  assert.equal(likePattern('snake_case'), '%snake\\_case%');
  assert.equal(likePattern('C:\\temp'), '%C:\\\\temp%');
  assert.equal(likePattern('%_\\'), '%\\%\\_\\\\%');
});

for (const [name, make] of [
  ['sql (PGlite)', async (): Promise<Store> => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async (): Promise<Store> => createMemoryStore()],
] as const) {
  const texts = async (store: Store, q: string, options: { to?: 'grok' | 'claude' | 'david'; pinned?: boolean; limit?: number } = {}) => {
    const query = parseQuery(q);
    assert.ok(query.ok, q);
    return (await store.search({ words: query.words, ...options })).map((m) => m.text);
  };

  test(`${name}: every word must be in the message, in any order and any case`, async () => {
    const store = await make();
    await store.add({ sender: 'grok', recipient: null, text: 'Which storage do we use for the images?' });
    await store.add({ sender: 'claude', recipient: 'grok', text: 'DECISION: Images go into the database.', pinned: true });
    await store.add({ sender: 'david', recipient: null, text: 'The storage question is settled.\nSecond line about images.' });
    await store.add({ sender: 'grok', recipient: null, text: 'Something else entirely.' });

    // Newest first.
    assert.deepEqual(await texts(store, 'images'), [
      'The storage question is settled.\nSecond line about images.',
      'DECISION: Images go into the database.',
      'Which storage do we use for the images?',
    ]);
    assert.deepEqual(await texts(store, 'IMAGES Storage'), [
      'The storage question is settled.\nSecond line about images.',
      'Which storage do we use for the images?',
    ]);
    // The words may be far apart, on different lines, and in the other order.
    assert.deepEqual(await texts(store, 'second settled'), ['The storage question is settled.\nSecond line about images.']);
    // A part of a word matches; a word that is nowhere finds nothing.
    assert.deepEqual(await texts(store, 'datab'), ['DECISION: Images go into the database.']);
    assert.deepEqual(await texts(store, 'images zebra'), []);
    assert.deepEqual(await texts(store, 'zebra'), []);
    // Upper and lower case also for letters beyond a to z.
    await store.add({ sender: 'david', recipient: null, text: 'Grüsse aus Zürich, ÄRGER mit Émile' });
    for (const q of ['zürich', 'ZÜRICH ärger', 'émile grüsse']) assert.equal((await texts(store, q)).length, 1, q);
  });

  test(`${name}: narrowed by recipient, to pinned messages, and by the limit`, async () => {
    const store = await make();
    await store.add({ sender: 'grok', recipient: null, text: 'plan one' });
    await store.add({ sender: 'claude', recipient: 'grok', text: 'DECISION: plan two', pinned: true });
    await store.add({ sender: 'david', recipient: 'grok', text: 'plan three' });
    const byHand = must(await store.add({ sender: 'david', recipient: null, text: 'plan four' }));
    await store.setPinned(byHand.id, true);

    assert.deepEqual(await texts(store, 'plan'), ['plan four', 'plan three', 'DECISION: plan two', 'plan one']);
    assert.deepEqual(await texts(store, 'plan', { to: 'grok' }), ['plan three', 'DECISION: plan two']);
    assert.deepEqual(await texts(store, 'plan', { pinned: true }), ['plan four', 'DECISION: plan two']);
    assert.deepEqual(await texts(store, 'plan', { pinned: true, to: 'grok' }), ['DECISION: plan two']);
    assert.deepEqual(await texts(store, 'plan', { limit: 2 }), ['plan four', 'plan three']);
    assert.deepEqual(await texts(store, 'plan', { limit: 1, to: 'grok' }), ['plan three']);
    // Without a limit: at most 50.
    for (let i = 0; i < 28; i++) await store.add({ sender: i % 2 ? 'grok' : 'claude', recipient: null, text: `bulk ${i}` }, 1000);
    for (let i = 28; i < 56; i++) await store.add({ sender: 'david', recipient: null, text: `bulk ${i}` }, 1000);
    const bulk = await texts(store, 'bulk');
    assert.equal(bulk.length, SEARCH_LIMIT);
    assert.equal(bulk[0], 'bulk 55');
    assert.equal(bulk[49], 'bulk 6');
  });

  test(`${name}: nothing in a query acts as a pattern`, async () => {
    const store = await make();
    await store.add({ sender: 'grok', recipient: null, text: 'We are at 100% now.' });
    await store.add({ sender: 'grok', recipient: null, text: 'We are at 100 percent now.' });
    await store.add({ sender: 'claude', recipient: null, text: 'Use snake_case here.' });
    await store.add({ sender: 'claude', recipient: null, text: 'Use snakeXcase here.' });
    await store.add({ sender: 'david', recipient: null, text: 'The path is C:\\temp\\new.' });
    await store.add({ sender: 'david', recipient: null, text: "It's a 'quoted' (bracketed) [thing]. Really? Yes.* ^$ {a|b} +1" });

    assert.deepEqual(await texts(store, '100%'), ['We are at 100% now.']);
    assert.deepEqual(await texts(store, '%'), ['We are at 100% now.']);
    assert.deepEqual(await texts(store, 'snake_case'), ['Use snake_case here.']);
    assert.deepEqual(await texts(store, '_'), ['Use snake_case here.']);
    assert.deepEqual(await texts(store, 'C:\\temp'), ['The path is C:\\temp\\new.']);
    assert.deepEqual(await texts(store, '\\'), ['The path is C:\\temp\\new.']);
    // Characters that mean something to a regular expression, or to SQL, are plain text too.
    for (const q of ["it's", "'quoted'", '(bracketed)', '[thing].', 'really?', 'yes.*', '^$', '{a|b}', '+1']) {
      assert.equal((await texts(store, q)).length, 1, q);
    }
    for (const q of ['.+', 'snake.case', 'a|b|zebra', "' OR 1=1 --", 'x%', '1__', 'Yes..']) assert.deepEqual(await texts(store, q), [], q);
  });

  test(`${name}: a poll's question and options count as text`, async () => {
    const store = await make();
    const { message } = must(await store.createPoll({ creator: 'david', question: 'Where do we eat on Friday?', options: ['Pizza place', 'Salad bar'] }));
    await store.add({ sender: 'grok', recipient: null, text: 'I like pizza.' });

    const found = await store.search({ words: ['salad'] });
    assert.deepEqual(found.map((m) => m.id), [message.id]);
    // The result is the whole message, with its poll, as everywhere else.
    assert.equal(found[0].poll?.question, 'Where do we eat on Friday?');
    assert.deepEqual(found[0].poll?.options.map((o) => o.text), ['Pizza place', 'Salad bar']);
    assert.deepEqual(found[0].attachments, []);
    assert.equal(found[0].reply_to, null);
    assert.deepEqual(await texts(store, 'pizza'), ['I like pizza.', 'Where do we eat on Friday?']);
    // One word from the question, one from an option, one from another option.
    assert.deepEqual(await texts(store, 'friday PIZZA bar'), ['Where do we eat on Friday?']);
    // A word cannot be glued together from the end of one part and the start of the next.
    assert.deepEqual(await texts(store, 'placesalad'), []);
    assert.deepEqual(await texts(store, 'friday?pizza'), []);
  });

  test(`${name}: a result carries its attachments and what it answers`, async () => {
    const store = await make();
    const first = must(await store.add({ sender: 'grok', recipient: null, text: 'the question' }));
    const upload = must(await store.addAttachment({ sender: 'claude', content_type: 'image/png', width: 4, height: 2, data: Buffer.from('not a real image') }));
    const reply = must(await store.add({ sender: 'claude', recipient: null, text: 'the answer', attachments: [upload.id], reply_to: first.id }));
    const [found] = await store.search({ words: ['answer'] });
    assert.deepEqual(found, (await store.list({ since: first.id }))[0]);
    assert.equal(found.id, reply.id);
    assert.equal(found.reply_to, first.id);
    assert.deepEqual(found.attachments.map((a) => a.id), [upload.id]);
    // No words: no results (the route never asks this).
    assert.deepEqual(await store.search({ words: [] }), []);
  });
}

// --- the route --------------------------------------------------------------------------------

const TOKENS: Record<string, string> = {
  grok: 'grok-test-token-0123456789abcdef',
  claude: 'claude-test-token-0123456789abcdef',
  david: 'david-test-token-0123456789abcdef',
};
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let messages: { GET: Handler; POST: Handler };
let polls: { POST: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {}; // silence the in-memory store warning
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  polls = (await import('../app/api/polls/route')) as unknown as typeof polls;
});

const BASE = 'http://hub.test';
const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const get = (path: string, who?: string) => messages.GET(new Request(BASE + path, { headers: auth(who) }));
const post = async (body: unknown, who: string) => {
  const res = await messages.POST(new Request(`${BASE}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: JSON.stringify(body) }));
  assert.equal(res.status, 201);
  return ((await res.json()) as { message: Message }).message;
};
const search = async (query: string, who = 'david') => {
  const res = await get(`/api/messages?${query}`, who);
  return { status: res.status, body: (await res.json()) as { me?: string; messages?: Message[]; pinned?: Message[]; polls?: unknown[]; error?: string } };
};

test('GET /api/messages?q= needs a token', async () => {
  for (const who of [undefined, 'not-a-real-token-0123456789']) {
    const res = await get('/api/messages?q=anything', who);
    assert.equal(res.status, 401);
    assert.deepEqual(Object.keys((await res.json()) as object), ['error']);
  }
});

test('GET /api/messages?q= finds messages, newest first, with their usual shape', async () => {
  const a = await post({ text: 'Search route: the first melon' }, 'grok');
  const b = await post({ text: '@grok DECISION: the second MELON is pinned' }, 'claude');
  const c = await post({ text: 'Search route: an answer about a melon', reply_to: a.id }, 'david');
  await post({ text: 'Search route: no fruit here' }, 'david');

  const all = await search('q=melon');
  assert.equal(all.status, 200);
  assert.equal(all.body.me, 'david');
  assert.deepEqual(all.body.messages?.map((m) => m.id), [c.id, b.id, a.id]);
  // A search answers with the matches and who you are; the pinned list and the polls are not repeated.
  assert.deepEqual(Object.keys(all.body).sort(), ['me', 'messages']);
  const answer = must(all.body.messages?.[0] ?? null);
  assert.deepEqual(Object.keys(answer).sort(), ['attachments', 'created_at', 'id', 'pinned_at', 'poll', 'recipient', 'reply_to', 'sender', 'text']);
  assert.equal(answer.reply_to, a.id);

  assert.deepEqual((await search('q=melon+route')).body.messages?.map((m) => m.id), [c.id, a.id]);
  assert.deepEqual((await search('q=melon&to=grok')).body.messages?.map((m) => m.id), [b.id]);
  assert.deepEqual((await search('q=melon&pinned=1')).body.messages?.map((m) => m.id), [b.id]);
  assert.deepEqual((await search('q=melon&pinned=0')).body.messages?.map((m) => m.id), [c.id, b.id, a.id]);
  assert.deepEqual((await search('q=melon&limit=2')).body.messages?.map((m) => m.id), [c.id, b.id]);
  assert.deepEqual((await search('q=melon&limit=')).body.messages?.length, 3);
  assert.deepEqual((await search('q=melon+kiwi')).body.messages, []);
  // Encoded special characters arrive as the characters they are.
  await post({ text: 'Search route: 100% melon_juice' }, 'grok');
  assert.equal((await search(`q=${encodeURIComponent('100% melon_juice')}`)).body.messages?.length, 1);
  assert.equal((await search(`q=${encodeURIComponent('melon_')}`)).body.messages?.length, 1);
  assert.equal((await search(`q=${encodeURIComponent('%')}+route`)).body.messages?.length, 1);
});

test('GET /api/messages?q= finds a poll by its options', async () => {
  const res = await polls.POST(new Request(`${BASE}/api/polls`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('grok') },
    body: JSON.stringify({ question: 'Search route: which fruit?', options: ['Papaya', 'Quince'] }),
  }));
  assert.equal(res.status, 201);
  const found = await search('q=quince+fruit');
  assert.equal(found.body.messages?.length, 1);
  assert.equal(found.body.messages?.[0].poll?.options[1].text, 'Quince');
});

test('GET /api/messages?q= refuses what is not a query', async () => {
  const bad = async (query: string, pattern: RegExp) => {
    const res = await search(query);
    assert.equal(res.status, 400, query);
    assert.match(res.body.error ?? '', pattern, query);
  };
  await bad('q=', /at least one word/);
  await bad('q=+++', /at least one word/);
  await bad(`q=${'x'.repeat(201)}`, /at most 200 characters/);
  await bad('q=a+b+c+d+e+f+g+h+i', /at most 8 words/);
  await bad('q=melon&since=3', /"since" cannot be combined with "q"/);
  await bad('q=melon&pinned=yes', /"pinned" must be 1 or 0/);
  await bad('q=melon&to=nobody', /"to" must be/);
  await bad('q=melon&limit=many', /"limit" must be/);
  assert.equal((await search(`q=${'x'.repeat(200)}`)).status, 200);
  assert.equal((await search('q=a+b+c+d+e+f+g+h')).status, 200);
});

test('GET /api/messages without q is what it was', async () => {
  const res = await search('limit=3');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['me', 'messages', 'pinned', 'polls']);
  assert.equal(res.body.messages?.length, 3);
  // Oldest first, as always.
  const ids = res.body.messages?.map((m) => m.id) ?? [];
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  // "pinned" without "q" is not a filter and is ignored, as any unknown parameter is.
  assert.equal((await search('limit=3&pinned=1')).body.messages?.length, 3);
  const since = await search(`since=${ids[0]}&limit=500`);
  assert.deepEqual(since.body.messages?.map((m) => m.id).slice(0, 2), [ids[1], ids[2]]);
});
