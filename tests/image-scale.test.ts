// An image is shown at the size it was taken. This file covers where its scale comes from (the
// density in the file, then a hint from the client, then 1), how it is stored, and that it is
// returned wherever an attachment is. The markup is checked in attachments-page.test.tsx.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import type { Message } from '../lib/core';
import { cleanImage } from '../lib/images';
import {
  DOWNSIZE_LONG_EDGE, SCALE_HINT_HEADER, downsizePlan, ownSize, parseScaleHint, pngDensity, scaleFromDensity, validScale,
  type Attachment,
} from '../lib/shared';
import { SCHEMA_SQL, createMemoryStore, createSqlStore, type Db, type NewAttachment, type Row, type Store } from '../lib/store';
import { createEventStream } from '../lib/stream';
import { jpeg, picture, png, webp } from './fixtures';

/** A 40×20 picture saved with a density, the way a screenshot tool on a high-density screen saves it. */
const pngAt = (dpi: number) => picture().withMetadata({ density: dpi }).png().toBuffer();
const jpegAt = (dpi: number) => picture().withMetadata({ density: dpi }).jpeg({ quality: 95 }).toBuffer();

const cleaned = async (bytes: Buffer, hint: number | null = null) => {
  const image = await cleanImage(bytes, hint);
  assert.ok(image.ok, JSON.stringify(image));
  return image;
};
const must = <T>(v: T | null | undefined): T => { assert.ok(v, 'expected a value'); return v; };

test('a density that stands for a screen gives the scale; any other says nothing', () => {
  assert.equal(scaleFromDensity(144), 2);
  assert.equal(scaleFromDensity(143.99), 2, 'PNG stores dots per metre, so 144 comes back a little off');
  assert.equal(scaleFromDensity(216), 3);
  assert.equal(scaleFromDensity(288), 4);
  for (const nothing of [undefined, null, 0, 1, 72, 96, 100, 120, 150, 192, 200, 300, 350, 360, 600, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(scaleFromDensity(nothing), null, String(nothing));
  }
});

test('a PNG with 144 dpi is stored with scale 2, one without a density with 1', async () => {
  assert.equal((await cleaned(await pngAt(144))).scale, 2);
  assert.equal((await cleaned(await png())).scale, 1);
  assert.equal((await cleaned(await pngAt(216))).scale, 3);
  assert.equal((await cleaned(await pngAt(288))).scale, 4);
  for (const ordinary of [72, 96, 300]) assert.equal((await cleaned(await pngAt(ordinary))).scale, 1, `${ordinary} dpi`);
  // JPEG records a density too. WebP has no place for one, so a WebP is 1 unless the client says more.
  assert.equal((await cleaned(await jpegAt(144))).scale, 2);
  assert.equal((await cleaned(await jpeg())).scale, 1);
  assert.equal((await cleaned(await webp())).scale, 1);
  // The size in pixels is what it was: the scale changes how large it is shown, never the image.
  const shot = await cleaned(await pngAt(144));
  assert.deepEqual([shot.width, shot.height], [40, 20]);
});

test('the hint counts only when the file itself says nothing', async () => {
  assert.equal((await cleaned(await png(), 2)).scale, 2);
  assert.equal((await cleaned(await png(), 3)).scale, 3);
  assert.equal((await cleaned(await png(), 1)).scale, 1);
  assert.equal((await cleaned(await webp(), 2)).scale, 2);
  assert.equal((await cleaned(await pngAt(96), 2)).scale, 2, '96 dpi is what any file has: the hint still counts');
  // What the file records wins over what the client says.
  assert.equal((await cleaned(await pngAt(144), 1)).scale, 2);
  assert.equal((await cleaned(await pngAt(144), 3)).scale, 2);
  assert.equal((await cleaned(await pngAt(216), 2)).scale, 3);
  // cleanImage never returns a scale outside 1 to 4, whatever it is handed.
  for (const bad of [0, -1, 5, 2.5, Number.NaN]) assert.equal((await cleaned(await png(), bad)).scale, 1, String(bad));
});

test('a hint is "1", "2" or "3" and nothing else', () => {
  assert.equal(parseScaleHint('1'), 1);
  assert.equal(parseScaleHint('2'), 2);
  assert.equal(parseScaleHint(' 3 '), 3);
  for (const ignored of [null, undefined, '', '0', '4', '-1', '2.0', '2.5', '02', '2x', 'two', '1e0', '2,3', 'NaN', '٢']) assert.equal(parseScaleHint(ignored), null, String(ignored));
});

test('own size: the pixels divided by the scale, never rounded up', () => {
  assert.deepEqual(ownSize({ width: 384, height: 230, scale: 2 }), { width: 192, height: 115 });
  assert.deepEqual(ownSize({ width: 384, height: 230, scale: 1 }), { width: 384, height: 230 });
  assert.deepEqual(ownSize({ width: 385, height: 231, scale: 2 }), { width: 192, height: 115 });
  assert.deepEqual(ownSize({ width: 1179, height: 2556, scale: 3 }), { width: 393, height: 852 });
  assert.deepEqual(ownSize({ width: 1, height: 1, scale: 4 }), { width: 1, height: 1 }, 'never less than a pixel');
  // An attachment from before the field existed, or a value that makes no sense, counts as 1.
  assert.deepEqual(ownSize({ width: 384, height: 230 }), { width: 384, height: 230 });
  for (const bad of [0, -2, 5, 1.5, '2', null, Number.NaN]) assert.equal(validScale(bad), 1, String(bad));
  assert.deepEqual([1, 2, 3, 4].map(validScale), [1, 2, 3, 4]);
});

test('the page can read the density of a PNG it has to shrink', async () => {
  const close = (dpi: number | null, expected: number) => assert.ok(dpi !== null && Math.abs(dpi - expected) < 0.05, `${dpi} ≈ ${expected}`);
  close(pngDensity(await pngAt(144)), 144);
  close(pngDensity(await pngAt(216)), 216);
  close(pngDensity(await pngAt(72)), 72);
  // The image library writes its own default into a file it was given no density for (1000 dots
  // per metre, 25.4 dpi). That stands for no screen, so it means nothing, like 72 or 96.
  assert.equal(scaleFromDensity(pngDensity(await png())), null);
  // A PNG with no pHYs chunk at all, as a browser's canvas writes it.
  const plain = await png();
  const at = plain.indexOf('pHYs') - 4;
  const without = Buffer.concat([plain.subarray(0, at), plain.subarray(at + 12 + 9)]);
  assert.equal(pngDensity(without), null, 'no density recorded');
  assert.ok((await cleanImage(without)).ok, 'and it is still a PNG the server takes');
  assert.equal(pngDensity(await jpegAt(144)), null, 'not a PNG');
  assert.equal(pngDensity(new Uint8Array(0)), null);
  assert.equal(pngDensity(new TextEncoder().encode('<html>not an image</html>')), null);
  // The start of the file is enough, and a file that is cut off anywhere is no reason to throw.
  const whole = await pngAt(144);
  close(pngDensity(whole.subarray(0, whole.indexOf('pHYs') + 4 + 9)), 144);
  for (let cut = 0; cut < whole.length; cut += 7) assert.doesNotThrow(() => pngDensity(whole.subarray(0, cut)));
  // "The unit is unknown" (0) only describes the shape of a pixel, not a density.
  const noUnit = Buffer.from(whole);
  noUnit[noUnit.indexOf('pHYs') + 4 + 8] = 0;
  assert.equal(pngDensity(noUnit), null);
});

test('an image that has to be shrunk keeps the size it has on the page, as far as whole scales allow', () => {
  const onPage = (p: { width: number; height: number; scale: number }) => ownSize(p);
  // A full-screen screenshot of a high-density screen: half the pixels, the same size on the page.
  const big = downsizePlan(5120, 2880, 2, DOWNSIZE_LONG_EDGE);
  assert.deepEqual(big, { width: 2560, height: 1440, scale: 1 });
  assert.deepEqual(onPage(big), onPage({ width: 5120, height: 2880, scale: 2 }));
  // A tall phone screenshot at scale 3: two thirds would still be too long, a third fits.
  const phone = downsizePlan(3540, 7668, 3, DOWNSIZE_LONG_EDGE);
  assert.deepEqual(phone, { width: 1180, height: 2556, scale: 1 });
  assert.deepEqual(onPage(phone), onPage({ width: 3540, height: 7668, scale: 3 }));
  const wideAtThree = downsizePlan(3600, 1800, 3, DOWNSIZE_LONG_EDGE);
  assert.deepEqual(wideAtThree, { width: 2400, height: 1200, scale: 2 }, 'the largest whole scale that fits is kept');
  assert.deepEqual(onPage(wideAtThree), onPage({ width: 3600, height: 1800, scale: 3 }));
  // Already within the long edge (it was only too heavy): the pixels and the scale stay.
  assert.deepEqual(downsizePlan(2400, 1500, 2, DOWNSIZE_LONG_EDGE), { width: 2400, height: 1500, scale: 2 });
  // An ordinary image, as before: the long edge comes down to the limit.
  assert.deepEqual(downsizePlan(4000, 3000, 1, DOWNSIZE_LONG_EDGE), { width: 2560, height: 1920, scale: 1 });
  assert.deepEqual(downsizePlan(1170, 2532, 1, DOWNSIZE_LONG_EDGE), { width: 1170, height: 2532, scale: 1 });
  // Too large even at scale 1: fitted, at scale 1. Larger on the page than before, but far larger than any thumbnail either way.
  assert.deepEqual(downsizePlan(6000, 4000, 2, DOWNSIZE_LONG_EDGE), { width: 2560, height: 1707, scale: 1 });
  // A scale of 4 can come from a file; a hint can say 3 at most.
  assert.equal(downsizePlan(2000, 1000, 4, DOWNSIZE_LONG_EDGE).scale, 3);
  for (const [w, h, s] of [[5120, 2880, 2], [3600, 7800, 3], [9000, 100, 4], [4000, 3000, 1], [7, 9000, 2]] as const) {
    const plan = downsizePlan(w, h, s, DOWNSIZE_LONG_EDGE);
    assert.ok(Math.max(plan.width, plan.height) <= DOWNSIZE_LONG_EDGE && plan.scale >= 1 && plan.scale <= 3, JSON.stringify(plan));
  }
});

// --- storage ------------------------------------------------------------------------------------------

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const shot = (scale?: number): NewAttachment => ({ sender: 'david', content_type: 'image/png', width: 384, height: 230, data: Buffer.from('not really an image'), ...(scale === undefined ? {} : { scale }) });
const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];

for (const [name, make] of STORES) {
  test(`${name}: the scale is stored and comes back wherever the attachment does`, async () => {
    const store = await make();
    const two = must(await store.addAttachment(shot(2)));
    const one = must(await store.addAttachment(shot()));
    assert.equal(two.scale, 2);
    assert.equal(one.scale, 1, 'left out: 1');
    assert.equal(must(await store.getAttachment(two.id)).attachment.scale, 2);

    const m = must(await store.add({ sender: 'david', recipient: null, text: 'DECISION: two sizes', pinned: true, attachments: [two.id, one.id] }));
    const scales = (message: Message | undefined) => must(message).attachments.map((a) => a.scale);
    assert.deepEqual(scales(m), [2, 1]);
    assert.deepEqual(scales((await store.list({ since: m.id - 1 }))[0]), [2, 1]);
    assert.deepEqual(scales((await store.list()).at(-1)), [2, 1]);
    assert.deepEqual(scales((await store.all()).at(-1)), [2, 1]);
    assert.deepEqual(scales((await store.pinned())[0]), [2, 1]);
    assert.deepEqual(scales(await store.setPinned(m.id, false) ?? undefined), [2, 1]);

    // The live stream sends the same objects.
    const reader = createEventStream({ store, me: 'claude', since: m.id - 1, intervalMs: 5, maxMs: 20 }).getReader();
    let wire = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; wire += new TextDecoder().decode(value); }
    assert.match(wire, /"scale":2/);

    for (const bad of [0, 5, -1, 1.5]) await assert.rejects(store.addAttachment(shot(bad)), `scale ${bad}`);
    assert.ok(await store.addAttachment(shot(4)));
  });
}

test('sql: someone writing to the table directly cannot store a scale outside 1 to 4', async () => {
  const pg = new PGlite();
  await createSqlStore(pgliteDb(pg)).ensure();
  const insert = (id: string, scale: number) => pg.query(`INSERT INTO attachments (id, sender, content_type, bytes, width, height, scale) VALUES ($1, 'david', 'image/png', 1, 1, 1, $2)`, [id, scale]);
  await assert.rejects(insert('att_zero', 0), /attachments_scale_range/);
  await assert.rejects(insert('att_five', 5), /attachments_scale_range/);
  await insert('att_four', 4);
  await pg.query(`INSERT INTO attachments (id, sender, content_type, bytes, width, height) VALUES ('att_default', 'david', 'image/png', 1, 1, 1)`);
  assert.deepEqual((await pg.query(`SELECT id, scale FROM attachments ORDER BY id`)).rows, [{ id: 'att_default', scale: 1 }, { id: 'att_four', scale: 4 }]);
});

test('sql: a database from before the scale gains the column on first request; its images count as 1', async () => {
  // The schema as it was: every statement except the one that adds the column.
  const statements = SCHEMA_SQL.split(';\n\n');
  const before = statements.filter((s) => !s.includes('ADD COLUMN scale'));
  assert.equal(before.length, statements.length - 1);
  const pg = new PGlite();
  await pg.exec(before.join(';\n\n'));
  await pg.exec(`INSERT INTO messages (sender, text) VALUES ('hub', 'welcome'), ('david', 'from before');`);
  await pg.query(`INSERT INTO attachments (id, sender, message_id, content_type, bytes, width, height, data) VALUES ('att_before0123456789abcdef', 'david', 2, 'image/png', 3, 384, 230, $1)`, [Buffer.from('old')]);
  const columns = async () => (await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'attachments' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  assert.ok(!(await columns()).includes('scale'));

  const store = createSqlStore(pgliteDb(pg));
  const old = (await store.all())[1].attachments;
  assert.deepEqual(old, [{ id: 'att_before0123456789abcdef', content_type: 'image/png', width: 384, height: 230, bytes: 3, scale: 1 }]);
  assert.ok(must(await store.getAttachment('att_before0123456789abcdef')).data.equals(Buffer.from('old')), 'the image itself is untouched');
  assert.equal(must(await store.addAttachment(shot(2))).scale, 2);

  // Running it all again, in any way, changes nothing: the next start, two at once, the file, the whole schema.
  const after = await columns();
  assert.equal(after.at(-1), 'scale');
  await createSqlStore(pgliteDb(pg)).ensure();
  await Promise.all([createSqlStore(pgliteDb(pg)).ensure(), createSqlStore(pgliteDb(pg)).ensure()]);
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../migrations/005-attachment-scale.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
  await pg.exec(SCHEMA_SQL);
  assert.deepEqual(await columns(), after);
  assert.deepEqual((await pg.query(`SELECT id, scale FROM attachments ORDER BY created_at, id`)).rows.map((r) => (r as { scale: number }).scale).sort(), [1, 2]);
});

// --- the routes ---------------------------------------------------------------------------------------

const TOKEN = 'david-scale-token-0123456789abcd';
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let uploads: { POST: Handler };
let messages: { GET: Handler; POST: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.DAVID_TOKEN = TOKEN;
  console.warn = () => {}; // silence the in-memory store warning
  uploads = (await import('../app/api/attachments/route')) as unknown as typeof uploads;
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const upload = async (bytes: Buffer, headers: Record<string, string> = {}): Promise<Attachment> => {
  const res = await uploads.POST(new Request('http://hub.test/api/attachments', { method: 'POST', headers: { ...auth, ...headers }, body: new Uint8Array(bytes) }));
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as Attachment;
};

test('upload: the answer carries the scale; the hint is accepted for 1 to 3 and ignored otherwise', async () => {
  const plain = await png();
  assert.deepEqual(Object.keys(await upload(plain)).sort(), ['bytes', 'content_type', 'height', 'id', 'scale', 'width']);
  assert.equal((await upload(plain)).scale, 1, 'no hint: 1 (what the command-line client sends)');
  assert.equal(SCALE_HINT_HEADER, 'X-Image-Scale');
  assert.equal((await upload(plain, { 'X-Image-Scale': '1' })).scale, 1);
  assert.equal((await upload(plain, { 'X-Image-Scale': '2' })).scale, 2);
  assert.equal((await upload(plain, { 'x-image-scale': '3' })).scale, 3);
  // Not an error, just no hint: the upload is stored with 1.
  for (const ignored of ['4', '0', '-2', '2.5', 'retina', '999999999999', '2; DROP TABLE attachments']) {
    assert.equal((await upload(plain, { 'X-Image-Scale': ignored })).scale, 1, ignored);
  }
  // A density in the file itself wins over the hint, in both directions.
  assert.equal((await upload(await pngAt(144))).scale, 2);
  assert.equal((await upload(await pngAt(144), { 'X-Image-Scale': '1' })).scale, 2);
  assert.equal((await upload(await pngAt(144), { 'X-Image-Scale': '3' })).scale, 2);
});

test('messages return the scale of each image', async () => {
  const shot2 = await upload(await sharp(await png(384, 230)).withMetadata({ density: 144 }).png().toBuffer());
  const pasted = await upload(await png(384, 230), { 'X-Image-Scale': '2' });
  const ordinary = await upload(await png(384, 230));
  const res = await messages.POST(new Request('http://hub.test/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ text: 'three of a kind', attachments: [shot2.id, pasted.id, ordinary.id] }),
  }));
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.deepEqual(message.attachments.map((a) => [a.width, a.height, a.scale]), [[384, 230, 2], [384, 230, 2], [384, 230, 1]]);
  const list = (await (await messages.GET(new Request(`http://hub.test/api/messages?since=${message.id - 1}`, { headers: auth }))).json()) as { messages: Message[] };
  assert.deepEqual(list.messages[0].attachments.map((a) => a.scale), [2, 2, 1]);
});
