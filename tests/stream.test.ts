// Live updates: the SSE encoder and parser, the store fingerprint, the server stream, and the route.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import { SSE_PING, createSseParser, sseEvent, type SseEvent } from '../lib/sse';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { createEventStream, pollMessageIdsChanged, reactionMessageIdsChanged } from '../lib/stream';

// --- encoder and parser ---------------------------------------------------------------------------

function parseAll(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  for (const c of chunks) parser.push(c);
  return events;
}

test('sseEvent writes one event with JSON on a single line', () => {
  const text = sseEvent('messages', [{ id: 1, text: 'line one\nline two' }]);
  assert.equal(text, 'event: messages\ndata: [{"id":1,"text":"line one\\nline two"}]\n\n');
  assert.equal(text.split('\n').length, 4, 'a newline inside the message text does not break the event');
});

test('parser: whole events, comments, and events split across chunks', () => {
  const wire = sseEvent('hello', { me: 'david' }) + SSE_PING + sseEvent('messages', [{ id: 7 }]);
  const expected = [
    { event: 'hello', data: '{"me":"david"}' },
    { event: 'messages', data: '[{"id":7}]' },
  ];
  assert.deepEqual(parseAll([wire]), expected);
  // Every possible split point, including in the middle of a multi-byte-free line and between the two newlines.
  for (let i = 1; i < wire.length; i++) assert.deepEqual(parseAll([wire.slice(0, i), wire.slice(i)]), expected, `split at ${i}`);
  // One character at a time.
  assert.deepEqual(parseAll([...wire]), expected);
});

test('parser: \\r\\n line ends, multi-line data, default event name, no space after the colon', () => {
  assert.deepEqual(parseAll(['event: a\r\ndata: 1\r\n\r\n']), [{ event: 'a', data: '1' }]);
  assert.deepEqual(parseAll(['data: one\ndata: two\n\n']), [{ event: 'message', data: 'one\ntwo' }]);
  assert.deepEqual(parseAll(['event:b\ndata:x\n\n']), [{ event: 'b', data: 'x' }]);
  assert.deepEqual(parseAll([': only a comment\n\n', 'event: lonely\n\n']), [], 'events without data are dropped');
  assert.deepEqual(parseAll(['event: unfinished\ndata: 1\n']), [], 'nothing fires before the blank line');
});

// --- store fingerprint ------------------------------------------------------------------------------

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

for (const [name, make] of STORES) {
  test(`${name}: version changes with new messages and with pins`, async () => {
    const store = await make();
    await store.ensure();
    assert.deepEqual(await store.version(), { last_id: 1, pins: '', polls: '0|', reactions: '0||' }, 'only the welcome message');
    const a = must(await store.add({ sender: 'david', recipient: null, text: 'one' }));
    const b = must(await store.add({ sender: 'grok', recipient: null, text: 'DECISION: two', pinned: true }));
    assert.deepEqual(await store.version(), { last_id: b.id, pins: String(b.id), polls: '0|', reactions: '0||' });
    await store.setPinned(a.id, true);
    assert.deepEqual(await store.version(), { last_id: b.id, pins: `${a.id},${b.id}`, polls: '0|', reactions: '0||' });
    await store.setPinned(b.id, false);
    assert.deepEqual(await store.version(), { last_id: b.id, pins: String(a.id), polls: '0|', reactions: '0||' });
  });
}

// --- the server stream ------------------------------------------------------------------------------

/** Reads a stream into parsed events. `next(n)` waits until n more events have arrived. */
function reader(stream: ReadableStream<Uint8Array>) {
  const events: SseEvent[] = [];
  let raw = '';
  let done = false;
  let wake: (() => void) | undefined;
  const parser = createSseParser((e) => events.push(e));
  const r = stream.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { done: d, value } = await r.read();
      if (d) break;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      parser.push(text);
      wake?.();
    }
    done = true;
    wake?.();
  })();
  let taken = 0;
  return {
    get raw() { return raw; },
    get done() { return done; },
    async next(n = 1, timeoutMs = 3000): Promise<{ event: string; data: unknown }[]> {
      const deadline = Date.now() + timeoutMs;
      while (events.length < taken + n && !done) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} event(s); got ${JSON.stringify(events.slice(taken))}`);
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 20); });
      }
      const out = events.slice(taken, taken + n).map((e) => ({ event: e.event, data: JSON.parse(e.data) as unknown }));
      taken += out.length;
      return out;
    },
    /** True if no further event arrives within ms. */
    async quiet(ms = 80): Promise<boolean> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return events.length === taken;
    },
    async finished(timeoutMs = 3000) { await Promise.race([pump, new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not end')), timeoutMs))]); },
    cancel: () => r.cancel(),
  };
}
const ids = (data: unknown) => (data as Message[]).map((m) => m.id);
const FAST = { intervalMs: 10, heartbeatMs: 10_000, maxMs: 60_000 };

for (const [name, make] of STORES) {
  test(`${name}: starts with hello, the latest messages and the pins, then pushes changes`, async () => {
    const store = await make();
    const first = must(await store.add({ sender: 'david', recipient: null, text: 'before the stream' }));
    const abort = new AbortController();
    const r = reader(createEventStream({ store, me: 'claude', since: null, signal: abort.signal, ...FAST }));

    const [hello, initial, pins] = await r.next(3);
    assert.deepEqual(hello, { event: 'hello', data: { me: 'claude' } });
    assert.equal(initial.event, 'messages');
    assert.deepEqual(ids(initial.data), [1, first.id], 'welcome plus the existing message, oldest first');
    assert.deepEqual(pins, { event: 'pins', data: [] });
    assert.ok(await r.quiet(), 'nothing is sent while nothing changes');

    // A new message is pushed, with its full content.
    const fresh = must(await store.add({ sender: 'grok', recipient: 'claude', text: '@claude hello **there**' }));
    const [pushed] = await r.next();
    assert.equal(pushed.event, 'messages');
    assert.deepEqual(pushed.data, [fresh]);

    // Pinning pushes the whole pinned list; unpinning pushes it again, empty.
    await store.setPinned(first.id, true);
    const [pinned] = await r.next();
    assert.equal(pinned.event, 'pins');
    assert.deepEqual(ids(pinned.data), [first.id]);
    await store.setPinned(first.id, false);
    assert.deepEqual(await r.next(), [{ event: 'pins', data: [] }]);

    // A burst arrives as one event, in order.
    const burst = [];
    for (let i = 0; i < 3; i++) burst.push(must(await store.add({ sender: 'david', recipient: null, text: `burst ${i}` })).id);
    const seen: number[] = [];
    while (seen.length < 3) seen.push(...ids((await r.next())[0].data));
    assert.deepEqual(seen, burst);

    abort.abort();
    await r.finished();
  });

  test(`${name}: ?since= sends only newer messages`, async () => {
    const store = await make();
    const a = must(await store.add({ sender: 'david', recipient: null, text: 'old' }));
    const b = must(await store.add({ sender: 'david', recipient: null, text: 'new' }));
    const abort = new AbortController();
    const r = reader(createEventStream({ store, me: 'david', since: a.id, signal: abort.signal, ...FAST }));
    const [, initial] = await r.next(3);
    assert.deepEqual(ids(initial.data), [b.id]);
    abort.abort();
    await r.finished();

    // Fully caught up: no messages event at all, only hello and pins.
    const abort2 = new AbortController();
    const r2 = reader(createEventStream({ store, me: 'david', since: b.id, signal: abort2.signal, ...FAST }));
    assert.deepEqual((await r2.next(2)).map((e) => e.event), ['hello', 'pins']);
    assert.ok(await r2.quiet());
    abort2.abort();
    await r2.finished();
  });
}

test('the stream says bye and ends at its time limit', async () => {
  const r = reader(createEventStream({ store: createMemoryStore(), me: 'david', since: null, intervalMs: 10, heartbeatMs: 10_000, maxMs: 50 }));
  await r.next(3);
  assert.deepEqual(await r.next(), [{ event: 'bye', data: { reason: 'time limit' } }]);
  await r.finished();
  assert.equal(r.done, true);
});

test('a quiet stream sends a ping comment, which the parser ignores', async () => {
  const abort = new AbortController();
  const r = reader(createEventStream({ store: createMemoryStore(), me: 'david', since: null, signal: abort.signal, intervalMs: 10, heartbeatMs: 30, maxMs: 60_000 }));
  await r.next(3);
  assert.ok(await r.quiet(120), 'pings are not events');
  assert.ok(r.raw.includes(SSE_PING));
  abort.abort();
  await r.finished();
});

test('the stream stops asking the store once the client is gone', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const version = store.version.bind(store);
  store.version = async () => { calls++; return version(); };
  const r = reader(createEventStream({ store, me: 'david', since: null, ...FAST }));
  await r.next(3);
  await r.cancel();
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(calls <= after + 1, `still polling after cancel: ${calls - after} more calls`);
});

test('a store failure ends the stream with an error event, without leaking details', async () => {
  const store = createMemoryStore();
  const realError = console.error;
  console.error = () => {};
  try {
    const r = reader(createEventStream({ store, me: 'david', since: null, ...FAST }));
    await r.next(3);
    store.version = async () => { throw new Error('connection to 10.0.0.5 refused'); };
    assert.deepEqual(await r.next(), [{ event: 'error', data: { message: 'Server error. Reconnect in a moment.' } }]);
    await r.finished();
    assert.ok(!r.raw.includes('10.0.0.5'));
  } finally {
    console.error = realError;
  }
});

// --- the route ----------------------------------------------------------------------------------------

const TOKEN = 'claude-test-token-0123456789abcdef';
let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.CLAUDE_TOKEN = TOKEN;
  console.warn = () => {};
  ({ GET } = (await import('../app/api/stream/route')) as unknown as { GET: typeof GET });
});

test('route: needs a token, validates since, and answers as an event stream', async () => {
  assert.equal((await GET(new Request('http://hub.test/api/stream'))).status, 401);
  assert.equal((await GET(new Request('http://hub.test/api/stream', { headers: { Authorization: 'Bearer wrong-token-0123456789' } }))).status, 401);
  const auth = { Authorization: `Bearer ${TOKEN}` };
  assert.equal((await GET(new Request('http://hub.test/api/stream?since=abc', { headers: auth }))).status, 400);

  const abort = new AbortController();
  const res = await GET(new Request('http://hub.test/api/stream', { headers: auth, signal: abort.signal }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store, no-transform');
  const r = reader(must(res.body));
  const [hello, initial, pins] = await r.next(3);
  // The route adds the id of the build the server runs ('dev' here, where no build set one).
  assert.deepEqual(hello, { event: 'hello', data: { me: 'claude', build: 'dev' } });
  assert.deepEqual(ids(initial.data), [1]);
  assert.equal(pins.event, 'pins');
  abort.abort();
  await r.finished();
});

test('pollMessageIdsChanged returns only ids whose entry changed', () => {
  assert.deepEqual(pollMessageIdsChanged('0|', '0|'), []);
  assert.deepEqual(pollMessageIdsChanged('0|', '1|12:0:t0'), [12]);
  // A vote on 12 does not re-send 13.
  assert.deepEqual(pollMessageIdsChanged('2|12:1:t0,13:1:t0', '2|12:2:t1,13:1:t0'), [12]);
  // A change at a constant count (someone switches option) still shows, because latest moved.
  assert.deepEqual(pollMessageIdsChanged('1|12:1:t0', '1|12:1:t1'), [12]);
});
// --- reactions: fingerprint and re-send without moving last ------------------------------------

for (const [name, make] of STORES) {
  test(`${name}: version changes with a reaction, not last_id`, async () => {
    const store = await make();
    const m = must(await store.add({ sender: 'david', recipient: null, text: 'please look' }));
    const before = await store.version();
    assert.equal(before.last_id, m.id);
    assert.equal(before.reactions, '0||');
    const added = await store.addReaction(m.id, 'claude', '👍');
    assert.equal(added.status, 'ok');
    const after = await store.version();
    assert.equal(after.last_id, before.last_id);
    assert.equal(after.pins, before.pins);
    assert.notEqual(after.reactions, before.reactions);
    const gone = await store.removeReaction(m.id, 'claude', '👍');
    assert.deepEqual(gone?.reactions, []);
    assert.equal((await store.version()).reactions, '0||');
  });

  test(`${name}: a reaction on an older message is re-sent without moving last`, async () => {
    const store = await make();
    const a = must(await store.add({ sender: 'david', recipient: null, text: 'old' }));
    const b = must(await store.add({ sender: 'grok', recipient: null, text: 'new' }));
    const abort = new AbortController();
    const r = reader(createEventStream({ store, me: 'claude', since: b.id, signal: abort.signal, ...FAST }));
    assert.deepEqual((await r.next(2)).map((e) => e.event), ['hello', 'pins']);
    assert.ok(await r.quiet());

    const added = await store.addReaction(a.id, 'claude', '👍');
    assert.equal(added.status, 'ok');
    const [updated] = await r.next();
    assert.equal(updated.event, 'messages');
    assert.deepEqual((updated.data as Message[]).map((m) => m.id), [a.id]);
    assert.deepEqual((updated.data as Message[])[0].reactions, [{ emoji: '👍', by: ['claude'] }]);

    const c = must(await store.add({ sender: 'david', recipient: null, text: 'after' }));
    const [fresh] = await r.next();
    assert.equal(fresh.event, 'messages');
    assert.deepEqual((fresh.data as Message[]).map((m) => m.id), [c.id], 'the cursor was not moved back to a');

    abort.abort();
    await r.finished();
  });
}

test('reactionMessageIdsChanged returns only ids whose entry changed, including a removal', () => {
  assert.deepEqual(reactionMessageIdsChanged('0||', '0||'), []);
  assert.deepEqual(reactionMessageIdsChanged('0||', '1|t0|12:1:t0'), [12]);
  // A reaction on 12 does not re-send 13.
  assert.deepEqual(reactionMessageIdsChanged('2|t0|12:1:t0,13:1:t0', '2|t1|12:2:t1,13:1:t0'), [12]);
  // A swap at a constant count still shows, because latest moved.
  assert.deepEqual(reactionMessageIdsChanged('1|t0|12:1:t0', '1|t1|12:1:t1'), [12]);
  // The last reaction on a message still re-sends that message so the client can clear it.
  assert.deepEqual(reactionMessageIdsChanged('1|t0|12:1:t0', '0||'), [12]);
});

test('a reaction re-sends only the message whose entry changed', async () => {
  const store = createMemoryStore();
  const a = must(await store.add({ sender: 'david', recipient: null, text: 'one' }));
  const b = must(await store.add({ sender: 'david', recipient: null, text: 'two' }));
  assert.equal((await store.addReaction(a.id, 'claude', '👍')).status, 'ok');
  assert.equal((await store.addReaction(b.id, 'grok', '🎉')).status, 'ok');
  const abort = new AbortController();
  const r = reader(createEventStream({ store, me: 'claude', since: b.id, signal: abort.signal, ...FAST }));
  assert.deepEqual((await r.next(2)).map((e) => e.event), ['hello', 'pins']);
  assert.ok(await r.quiet());

  assert.equal((await store.addReaction(a.id, 'david', '❤️')).status, 'ok');
  const [updated] = await r.next();
  assert.equal(updated.event, 'messages');
  assert.deepEqual((updated.data as Message[]).map((m) => m.id), [a.id], 'the unchanged reaction is not re-sent');
  assert.deepEqual((updated.data as Message[])[0].reactions.map((x) => x.emoji).sort(), ['👍', '❤️'].sort());

  abort.abort();
  await r.finished();
});
