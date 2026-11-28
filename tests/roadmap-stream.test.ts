// The roadmap updates live: a fingerprint in both stores, and a small stream that sends every card
// at the start and again after each change (the roadmap page used to ask every 20 seconds).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { createRoadmapStream } from '../lib/stream';
import { createSseParser, type SseEvent } from '../lib/sse';
import type { RoadmapItem } from '../lib/roadmap';

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

const STORES: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['sql (PGlite)', async () => { const s = createSqlStore(pgliteDb(new PGlite())); await s.ensure(); return s; }],
];

for (const [name, make] of STORES) {
  test(`${name}: the fingerprint changes with every kind of change, and only then`, async () => {
    const store = await make();
    const seen = new Set<string>();
    const changed = async (what: string) => {
      const v = await store.roadmapVersion();
      assert.ok(!seen.has(v), `${what}: a new fingerprint`);
      seen.add(v);
    };
    await changed('empty');
    assert.equal(await store.roadmapVersion(), [...seen][0], 'asking again changes nothing');
    const a = (await store.addRoadmapItem({ column: 'next', title: 'A', note: '', owner: null, by: 'claude' }))!;
    await changed('a card added');
    const b = (await store.addRoadmapItem({ column: 'next', title: 'B', note: '', owner: null, by: 'grok' }))!;
    await changed('a second card');
    await store.reorderRoadmap('next', [b.id, a.id], 'david');
    await changed('reordered (positions only)');
    await new Promise((r) => setTimeout(r, 5)); // updated_at has millisecond steps
    await store.claimRoadmapItem(a.id, 'claude', 'building');
    await changed('claimed');
    await new Promise((r) => setTimeout(r, 5));
    await store.updateRoadmapItem(b.id, { column: 'now' }, 'grok');
    await changed('moved to another column');
    await store.deleteRoadmapItem(a.id);
    await changed('removed');
  });

  test(`${name}: the stream sends every card at once, then again after a change`, async () => {
    const store = await make();
    await store.addRoadmapItem({ column: 'next', title: 'First', note: '', owner: null, by: 'claude' });
    const abort = new AbortController();
    const events: SseEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    const reader = createRoadmapStream({ store, signal: abort.signal, intervalMs: 10, heartbeatMs: 10_000, maxMs: 60_000 }).getReader();
    const decoder = new TextDecoder();
    void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; parser.push(decoder.decode(value, { stream: true })); } })();
    const until = async (n: number) => { const end = Date.now() + 3000; while (events.length < n) { if (Date.now() > end) throw new Error(`only ${events.length} events`); await new Promise((r) => setTimeout(r, 10)); } };
    const titles = (e: SseEvent) => (JSON.parse(e.data) as { items: RoadmapItem[] }).items.map((i) => i.title);
    await until(1);
    assert.equal(events[0].event, 'roadmap');
    assert.deepEqual(titles(events[0]), ['First']);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(events.length, 1, 'nothing more while nothing changes');
    await store.addRoadmapItem({ column: 'now', title: 'Second', note: '', owner: null, by: 'grok' });
    await until(2);
    assert.equal(events[1].event, 'roadmap');
    assert.deepEqual(titles(events[1]).sort(), ['First', 'Second']);
    abort.abort();
  });
}

test('the stream says goodbye at its time limit, so the page reconnects', async () => {
  const events: SseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  const reader = createRoadmapStream({ store: createMemoryStore(), intervalMs: 10, heartbeatMs: 10_000, maxMs: 40 }).getReader();
  const decoder = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parser.push(decoder.decode(value, { stream: true })); }
  assert.deepEqual(events.map((e) => e.event), ['roadmap', 'bye']);
});

test('a quiet stream sends a ping now and then, so proxies keep it open', async () => {
  const reader = createRoadmapStream({ store: createMemoryStore(), intervalMs: 10, heartbeatMs: 30, maxMs: 200 }).getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; raw += decoder.decode(value, { stream: true }); }
  assert.match(raw, /: ping/);
});
