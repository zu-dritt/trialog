// The same contract runs against the real SQL (on PGlite, an in-process Postgres) and the memory store.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { welcomeText } from '../lib/core';
import { DEFAULT_PARTICIPANTS, parseParticipants } from '../lib/participants';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';

/** Db adapter for PGlite, with the same shape as the pg adapter in lib/store.ts. */
function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

async function sqlStore(): Promise<Store> {
  return createSqlStore(pgliteDb(new PGlite()));
}

const must = <T>(v: T | null): T => {
  assert.ok(v, 'expected a value');
  return v;
};

for (const [name, make] of [['sql (PGlite)', sqlStore], ['memory', async () => createMemoryStore()]] as const) {
  test(`${name}: seeds exactly one welcome message`, async () => {
    const store = await make();
    await store.ensure();
    await store.ensure();
    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].sender, 'hub');
    assert.equal(all[0].text, welcomeText(parseParticipants(DEFAULT_PARTICIPANTS)));
    assert.match(all[0].text, /Grok, Claude and David share this stream/);
  });

  test(`${name}: add, list since, filter by recipient`, async () => {
    const store = await make();
    const a = must(await store.add({ sender: 'grok', recipient: 'claude', text: 'hi claude' }));
    const b = must(await store.add({ sender: 'claude', recipient: null, text: 'hi all' }));
    const c = must(await store.add({ sender: 'david', recipient: 'claude', text: 'ping' }));
    assert.equal(typeof a.id, 'number');
    assert.ok(a.id < b.id && b.id < c.id);
    assert.equal(a.sender, 'grok');
    assert.equal(a.recipient, 'claude');
    assert.equal(b.recipient, null);
    assert.ok(!Number.isNaN(Date.parse(a.created_at)));

    assert.deepEqual((await store.list({ since: a.id })).map((m) => m.id), [b.id, c.id]);
    assert.deepEqual((await store.list({ since: 0, to: 'claude' })).map((m) => m.text), ['hi claude', 'ping']);
    assert.deepEqual((await store.list({ since: c.id })), []);
    // Without since: the latest n, oldest first.
    assert.deepEqual((await store.list({ limit: 2 })).map((m) => m.id), [b.id, c.id]);
  });

  test(`${name}: pin, unpin and DECISION pins`, async () => {
    const store = await make();
    const d = must(await store.add({ sender: 'david', recipient: null, text: 'DECISION: go', pinned: true }));
    const e = must(await store.add({ sender: 'grok', recipient: null, text: 'note' }));
    assert.ok(d.pinned_at);
    assert.equal(e.pinned_at, null);
    assert.deepEqual((await store.pinned()).map((m) => m.id), [d.id]);
    await store.setPinned(e.id, true);
    assert.deepEqual((await store.pinned()).map((m) => m.id), [d.id, e.id]);
    await store.setPinned(d.id, false);
    assert.deepEqual((await store.pinned()).map((m) => m.id), [e.id]);
    assert.equal(await store.setPinned(999999, true), null);
  });

  test(`${name}: rate limit per sender per minute`, async () => {
    const store = await make();
    for (let i = 0; i < 3; i++) assert.ok(await store.add({ sender: 'grok', recipient: null, text: `m${i}` }, 3));
    assert.equal(await store.add({ sender: 'grok', recipient: null, text: 'one too many' }, 3), null);
    assert.ok(await store.add({ sender: 'claude', recipient: null, text: 'others still can' }, 3));
  });
}

test('sql: messages and pins survive a restart (new connection, same database)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trialog-'));
  try {
    const db1 = new PGlite(dir);
    const s1 = createSqlStore(pgliteDb(db1));
    const m = must(await s1.add({ sender: 'grok', recipient: 'claude', text: 'DECISION: keep me', pinned: true }));
    await db1.close();

    const db2 = new PGlite(dir);
    const s2 = createSqlStore(pgliteDb(db2));
    const all = await s2.all();
    assert.deepEqual(all.map((x) => x.sender), ['hub', 'grok'], 'no second welcome, old message kept');
    assert.deepEqual((await s2.pinned()).map((x) => x.id), [m.id]);
    const next = must(await s2.add({ sender: 'claude', recipient: null, text: 'after restart' }));
    assert.ok(next.id > m.id);
    await db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Who is a participant is decided by the application (the PARTICIPANTS setting). The store only
// refuses what could never be a name, as the last line of defence.
for (const [name, make] of [['sql (PGlite)', sqlStore], ['memory', async () => createMemoryStore()]] as const) {
  test(`${name}: the store refuses senders and recipients that don't have the shape of a name`, async () => {
    const store = await make();
    await store.ensure();
    for (const bad of ['Mallory', 'mal lory', '1mallory', 'mallory!', '', 'm'.repeat(25), "x'; DROP TABLE messages; --"]) {
      await assert.rejects(store.add({ sender: bad, recipient: null, text: 'x' }), `sender ${JSON.stringify(bad)}`);
      if (bad !== '') await assert.rejects(store.add({ sender: 'grok', recipient: bad, text: 'x' }), `recipient ${JSON.stringify(bad)}`);
    }
    assert.equal((await store.all()).length, 1, 'only the welcome message is there');
    // Any well-formed name is stored: whether it is a participant was decided before the store is asked.
    assert.ok(await store.add({ sender: 'quill-2', recipient: 'ana-maria', text: 'x' }));
  });
}
