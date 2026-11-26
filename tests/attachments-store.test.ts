// The attachment part of the store contract, on the real SQL (PGlite) and on the memory store.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createMemoryBlobs, createSqlBlobs } from '../lib/blobs';
import { ATTACHMENT_ID, MAX_ATTACHMENT_BYTES, type Attachment, type Message } from '../lib/core';
import { createSseParser, type SseEvent } from '../lib/sse';
import { AttachmentLinkError, createMemoryStore, createSqlStore, type Db, type NewAttachment, type Row, type Store } from '../lib/store';
import { createEventStream } from '../lib/stream';

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

/** A store, and a way to make every upload in it `ms` older. */
interface Kit { store: Store; age(ms: number): Promise<void> }
const KITS: [string, () => Promise<Kit>][] = [
  ['sql (PGlite)', async () => {
    const pg = new PGlite();
    const store = createSqlStore(pgliteDb(pg));
    await store.ensure();
    return { store, age: async (ms) => { await pg.query(`UPDATE attachments SET created_at = created_at - $1::int * interval '1 millisecond'`, [ms]); } };
  }],
  ['memory', async () => {
    let clock = Date.now();
    return { store: createMemoryStore({ now: () => clock }), age: async (ms) => { clock += ms; } };
  }],
];

const MINUTE = 60_000;
const must = <T>(v: T | null | undefined): T => { assert.ok(v, 'expected a value'); return v; };
// The store takes bytes that are already clean, so any bytes will do here.
const bytes = (label: string) => Buffer.from(`not really an image: ${label}`);
const shot = (sender: NewAttachment['sender'], label = 'x'): NewAttachment => ({ sender, content_type: 'image/png', width: 40, height: 20, data: bytes(label) });
const linkError = (reason: AttachmentLinkError['reason']) => (e: unknown) => e instanceof AttachmentLinkError && e.reason === reason;

for (const [name, make] of KITS) {
  test(`${name}: an upload is stored and read back byte for byte`, async () => {
    const { store } = await make();
    const a = must(await store.addAttachment({ sender: 'david', content_type: 'image/webp', width: 1170, height: 2532, data: bytes('a') }));
    assert.match(a.id, ATTACHMENT_ID);
    assert.deepEqual(a, { id: a.id, content_type: 'image/webp', width: 1170, height: 2532, bytes: bytes('a').length });
    const found = must(await store.getAttachment(a.id));
    assert.deepEqual(found.attachment, { ...a, sender: 'david', message_id: null });
    assert.ok(found.data.equals(bytes('a')));
    assert.equal(await store.getAttachment('att_0123456789abcdef01234567'), null);
    const b = must(await store.addAttachment(shot('david', 'b')));
    assert.notEqual(a.id, b.id);
  });

  test(`${name}: a message carries its attachments wherever it is returned`, async () => {
    const { store } = await make();
    const a = must(await store.addAttachment(shot('david', 'a')));
    const b = must(await store.addAttachment(shot('david', 'b')));
    const plain = must(await store.add({ sender: 'grok', recipient: null, text: 'no image' }));
    const m = must(await store.add({ sender: 'david', recipient: null, text: 'DECISION: two images', pinned: true, attachments: [b.id, a.id] }));
    assert.deepEqual(m.attachments, [b, a], 'in the order the sender gave, not the order of upload');
    assert.deepEqual(plain.attachments, []);

    const expectIn = (list: Message[], where: string) => {
      assert.deepEqual(list.find((x) => x.id === m.id)?.attachments, [b, a], where);
      for (const other of list.filter((x) => x.id !== m.id)) assert.deepEqual(other.attachments, [], `${where}: others have none`);
    };
    expectIn(await store.list(), 'list (latest)');
    expectIn(await store.list({ since: 0 }), 'list (since)');
    expectIn(await store.all(), 'all');
    expectIn(await store.pinned(), 'pinned');
    assert.deepEqual(must(await store.setPinned(m.id, false)).attachments, [b, a], 'setPinned');
    assert.equal(must(await store.getAttachment(a.id)).attachment.message_id, m.id);

    // The live stream sends the same message objects.
    const events: SseEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    const reader = createEventStream({ store, me: 'claude', since: plain.id, intervalMs: 5, maxMs: 20 }).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    const streamed = JSON.parse(must(events.find((e) => e.event === 'messages')).data) as Message[];
    assert.deepEqual(streamed.map((x) => [x.id, x.attachments]), [[m.id, [b, a]]]);
  });

  test(`${name}: refuses to link someone else's, an already linked or an unknown upload, and stores nothing`, async () => {
    const { store } = await make();
    const mine = must(await store.addAttachment(shot('david', 'mine')));
    const theirs = must(await store.addAttachment(shot('grok', 'theirs')));
    const count = (await store.all()).length;

    await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'x', attachments: [theirs.id] }), linkError('not yours'));
    await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'x', attachments: [mine.id, theirs.id] }), linkError('not yours'));
    await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'x', attachments: ['att_0123456789abcdef01234567'] }), linkError('unknown'));
    assert.equal((await store.all()).length, count, 'no message was stored');
    assert.equal(must(await store.getAttachment(mine.id)).attachment.message_id, null, 'and the valid upload in the refused message stays unlinked');

    const m = must(await store.add({ sender: 'david', recipient: null, text: 'ok', attachments: [mine.id] }));
    await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'again', attachments: [mine.id] }), linkError('already linked'));
    assert.equal(must(await store.getAttachment(mine.id)).attachment.message_id, m.id, 'still linked to the first message');
    assert.equal((await store.all()).length, count + 1);
  });

  test(`${name}: the next upload deletes uploads left unlinked for more than an hour`, async () => {
    const { store, age } = await make();
    const orphan = must(await store.addAttachment(shot('david', 'orphan')));
    const linked = must(await store.addAttachment(shot('david', 'linked')));
    must(await store.add({ sender: 'david', recipient: null, text: 'keeps one', attachments: [linked.id] }));

    await age(59 * MINUTE);
    const young = must(await store.addAttachment(shot('grok', 'young')));
    assert.ok(await store.getAttachment(orphan.id), 'under an hour: still there');

    await age(2 * MINUTE);
    assert.ok(await store.getAttachment(orphan.id), 'nothing is deleted until the next upload');
    must(await store.addAttachment(shot('claude', 'trigger')));
    assert.equal(await store.getAttachment(orphan.id), null, 'over an hour and unlinked: deleted, bytes included');
    assert.ok(await store.getAttachment(linked.id), 'a linked attachment is kept however old it is');
    assert.ok(await store.getAttachment(young.id), 'a younger orphan is kept');
    await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'too late', attachments: [orphan.id] }), linkError('unknown'));
  });

  test(`${name}: uploads are limited per sender per hour`, async () => {
    const { store, age } = await make();
    for (let i = 0; i < 3; i++) assert.ok(await store.addAttachment(shot('grok', `g${i}`), 3));
    assert.equal(await store.addAttachment(shot('grok', 'one too many'), 3), null);
    assert.ok(await store.addAttachment(shot('claude', 'others still can'), 3));
    // Linking an upload does not free a slot: the limit counts uploads, not orphans.
    const first = must(await store.addAttachment(shot('david', 'd0'), 2));
    must(await store.add({ sender: 'david', recipient: null, text: 'linked', attachments: [first.id] }));
    assert.ok(await store.addAttachment(shot('david', 'd1'), 2));
    assert.equal(await store.addAttachment(shot('david', 'd2'), 2), null);
    // The quick count the route asks for before decoding sees the same uploads, refused ones not included.
    assert.deepEqual([await store.uploadsInLastHour('grok'), await store.uploadsInLastHour('claude'), await store.uploadsInLastHour('david')], [3, 1, 2]);
    // An hour later the window has moved on.
    await age(61 * MINUTE);
    assert.equal(await store.uploadsInLastHour('grok'), 0);
    assert.equal(await store.uploadsInLastHour('david'), 0, 'a linked upload is kept, but it no longer counts');
    assert.ok(await store.addAttachment(shot('grok', 'next hour'), 3));
    assert.ok(await store.addAttachment(shot('david', 'next hour'), 2));
    assert.equal(await store.uploadsInLastHour('grok'), 1);
  });
}

test('the 4 MB cap holds on the storage path too: the byte store and the database both refuse', async () => {
  const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1);
  const noDb = { query: async () => [] };
  await assert.rejects(createMemoryBlobs().put(noDb, 'att_0123456789abcdef01234567', tooBig), /between 1 byte and/);
  await assert.rejects(createSqlBlobs().put(noDb, 'att_0123456789abcdef01234567', tooBig), /between 1 byte and/);
  await assert.rejects(createSqlBlobs().put(noDb, 'att_0123456789abcdef01234567', Buffer.alloc(0)), /between 1 byte and/);
  for (const [, make] of KITS) {
    const { store } = await make();
    await assert.rejects(store.addAttachment({ ...shot('david'), data: tooBig }));
  }
  // Someone writing to the table directly, past the app, is stopped by the CHECK constraints.
  const pg = new PGlite();
  await createSqlStore(pgliteDb(pg)).ensure();
  const insert = (size: number, data: Buffer | null) => pg.query(
    `INSERT INTO attachments (id, sender, content_type, bytes, width, height, data) VALUES ('att_direct', 'david', 'image/png', $1, 1, 1, $2)`,
    [size, data],
  );
  await assert.rejects(insert(MAX_ATTACHMENT_BYTES + 1, null), /check/i);
  await assert.rejects(insert(10, Buffer.alloc(11)), /check/i, 'the bytes must be as long as the row says');
  await assert.rejects(pg.query(`INSERT INTO attachments (id, sender, content_type, bytes, width, height) VALUES ('att_gif', 'david', 'image/gif', 1, 1, 1)`), /check/i);
});

test('sql: a database from before attachments gains the table on first request and keeps its history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trialog-'));
  try {
    // The schema as it was before this change: everything except migration 002.
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    const old = schema.slice(0, schema.indexOf('CREATE TABLE IF NOT EXISTS attachments'));
    assert.ok(old.includes('webhook_state') && !old.includes('attachments'));
    const db1 = new PGlite(dir);
    await db1.exec(old);
    await db1.query(`INSERT INTO messages (sender, text) VALUES ('hub', 'welcome'), ('david', 'from before')`, []);
    await db1.close();

    const db2 = new PGlite(dir);
    const store = createSqlStore(pgliteDb(db2));
    assert.deepEqual((await store.all()).map((m) => [m.text, m.attachments]), [['welcome', []], ['from before', []]]);
    const a = must(await store.addAttachment(shot('david', 'kept')));
    const m = must(await store.add({ sender: 'david', recipient: null, text: 'with image', attachments: [a.id] }));
    await db2.close();

    // Running the schema a second time changes nothing, and the image survives the restart.
    const db3 = new PGlite(dir);
    const again = createSqlStore(pgliteDb(db3));
    await again.ensure();
    assert.deepEqual((await again.all()).map((x) => x.attachments.length), [0, 0, 1]);
    const found = must(await again.getAttachment(a.id));
    assert.ok(found.data.equals(bytes('kept')));
    assert.equal(found.attachment.message_id, m.id);
    await db3.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ids stay in commit order when messages with and without attachments are posted together', async () => {
  for (const [, make] of KITS) {
    const { store } = await make();
    const uploads: Attachment[] = [];
    for (let i = 0; i < 4; i++) uploads.push(must(await store.addAttachment(shot('david', `c${i}`))));
    const posted = await Promise.all([
      store.add({ sender: 'david', recipient: null, text: 'a', attachments: [uploads[0].id, uploads[1].id] }),
      store.add({ sender: 'grok', recipient: null, text: 'b' }),
      store.add({ sender: 'david', recipient: null, text: 'c', attachments: [uploads[2].id] }),
      store.add({ sender: 'claude', recipient: null, text: 'd' }),
    ]);
    const ids = posted.map((m) => must(m).id);
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'ids were handed out in order');
    assert.deepEqual((await store.list({ since: ids[0] - 1 })).map((m) => [m.id, m.attachments.length]), [[ids[0], 2], [ids[1], 0], [ids[2], 1], [ids[3], 0]]);
  }
});
