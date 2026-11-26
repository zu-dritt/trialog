// Image attachments through the real route handlers (memory store, test tokens).
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ATTACHMENT_ID, MAX_ATTACHMENT_BYTES, type Attachment, type Message } from '../lib/core';
import { FAKE_CAMERA, FAKE_GPS_DATE, jpeg, noisePng, phoneJpeg, pixel, png, webp } from './fixtures';

const TOKENS: Record<string, string> = {
  grok: 'grok-test-token-0123456789abcdef',
  claude: 'claude-test-token-0123456789abcdef',
  david: 'david-test-token-0123456789abcdef',
};

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let messages: { GET: Handler; POST: Handler };
let uploads: { POST: Handler };
let image: { GET: Handler };
let exportRoute: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {}; // silence the in-memory store warning
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  uploads = (await import('../app/api/attachments/route')) as unknown as typeof uploads;
  image = (await import('../app/api/attachments/[id]/route')) as unknown as typeof image;
  exportRoute = (await import('../app/api/export/route')) as unknown as typeof exportRoute;
});

const URL_BASE = 'http://hub.test';
const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const upload = (bytes: Uint8Array | string, who?: string, headers: Record<string, string> = {}) => uploads.POST(new Request(`${URL_BASE}/api/attachments`, {
  method: 'POST',
  headers: { ...auth(who), ...headers },
  body: typeof bytes === 'string' ? bytes : new Uint8Array(bytes),
}));
const uploaded = async (bytes: Uint8Array, who: string): Promise<Attachment> => {
  const res = await upload(bytes, who);
  assert.equal(res.status, 201, 'the upload is accepted');
  return (await res.json()) as Attachment;
};
const download = (id: string, who?: string) => image.GET(new Request(`${URL_BASE}/api/attachments/${id}`, { headers: auth(who) }), { params: Promise.resolve({ id }) });
const post = (body: unknown, who?: string) => messages.POST(new Request(`${URL_BASE}/api/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth(who) },
  body: JSON.stringify(body),
}));
const list = async (who = 'david') => ((await (await messages.GET(new Request(`${URL_BASE}/api/messages?since=0`, { headers: auth(who) }))).json()) as { messages: Message[] }).messages;
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

test('without a token nothing can be uploaded and nothing can be read', async () => {
  const mine = await uploaded(await png(), 'david');
  for (const who of [undefined, 'not-a-real-token-0123456789']) {
    assert.equal((await upload(await png(), who)).status, 401);
    const res = await download(mine.id, who);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.match(res.headers.get('content-type') ?? '', /json/, 'the answer is the JSON error, never image bytes');
  }
});

test('a ".png" that is really HTML is rejected, whatever the header says', async () => {
  const html = '<!doctype html><html><body><script>alert(1)</script></body></html>';
  const res = await upload(html, 'david', { 'Content-Type': 'image/png', 'X-Filename': 'screenshot.png' });
  assert.equal(res.status, 415);
  assert.match(await errorOf(res), /PNG, JPEG and WebP/);
  // Other things that are not one of the three types.
  assert.equal((await upload(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'david', { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await upload('<svg xmlns="http://www.w3.org/2000/svg"/>', 'david', { 'Content-Type': 'image/webp' })).status, 415);
  // The first bytes of a PNG, followed by something else: the decoder has the last word.
  const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>')]);
  assert.equal((await upload(fake, 'david', { 'Content-Type': 'image/png' })).status, 400);
  assert.equal((await upload('', 'david', { 'Content-Type': 'image/png' })).status, 400, 'an empty body');
});

test('EXIF and GPS are gone after upload, and the picture is turned upright first', async () => {
  const original = await phoneJpeg();
  const before = await sharp(original).metadata();
  assert.deepEqual([before.width, before.height, before.orientation], [40, 20, 6], 'the fixture lies on its side');
  assert.ok(before.exif && original.includes(FAKE_CAMERA) && original.includes(FAKE_GPS_DATE), 'the fixture carries a camera name and a GPS date');

  const a = await uploaded(original, 'david');
  assert.match(a.id, ATTACHMENT_ID);
  assert.deepEqual([a.content_type, a.width, a.height], ['image/jpeg', 20, 40], 'turned 90°: now 20 wide and 40 high');

  const res = await download(a.id, 'david');
  assert.equal(res.status, 200);
  const stored = Buffer.from(await res.arrayBuffer());
  assert.equal(stored.length, a.bytes);
  const after = await sharp(stored).metadata();
  assert.equal(after.exif, undefined, 'no EXIF block at all');
  assert.equal(after.xmp, undefined);
  assert.equal(after.iptc, undefined);
  assert.equal(after.icc, undefined);
  assert.equal(after.orientation, undefined, 'no orientation tag left that a viewer could apply a second time');
  assert.ok(!stored.includes(FAKE_CAMERA) && !stored.includes(FAKE_GPS_DATE) && !stored.includes('Exif'), 'none of the metadata bytes survive');

  // The red half was on the left of the stored pixels. Turned 90° clockwise it is at the top.
  const [top, bottom] = [await pixel(stored, 10, 5), await pixel(stored, 10, 35)];
  assert.ok(top[0] > 200 && top[2] < 60, `top is red, got ${top}`);
  assert.ok(bottom[2] > 200 && bottom[0] < 60, `bottom is blue, got ${bottom}`);
});

test('PNG and WebP keep their type, decided by content and not by the Content-Type header', async () => {
  const p = await uploaded(await png(30, 10), 'david');
  assert.deepEqual([p.content_type, p.width, p.height], ['image/png', 30, 10]);
  const res = await upload(await webp(12, 34), 'david', { 'Content-Type': 'text/html' });
  assert.equal(res.status, 201);
  const w = (await res.json()) as Attachment;
  assert.deepEqual([w.content_type, w.width, w.height], ['image/webp', 12, 34]);
  const served = await download(w.id, 'david');
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('cache-control') ?? '', /^private/, 'never cacheable by a shared cache');
  assert.equal((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format, 'webp');
});

test('the 4 MB cap: over it is refused before any decoding, just under it is stored', async () => {
  const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const res = await upload(tooBig, 'david');
  assert.equal(res.status, 413);
  assert.match(await errorOf(res), /larger than 4 MB/);
  // A declared length alone is enough to refuse.
  assert.equal((await upload('x', 'david', { 'Content-Length': String(MAX_ATTACHMENT_BYTES + 1) })).status, 413);
  // A body that arrives in pieces with no declared length is counted while it is read.
  let sent = 0;
  const chunk = new Uint8Array(512 * 1024);
  const endless = new ReadableStream<Uint8Array>({ pull(c) { sent += chunk.length; c.enqueue(chunk); } });
  const streamed = await uploads.POST(new Request(`${URL_BASE}/api/attachments`, { method: 'POST', headers: auth('david'), body: endless, duplex: 'half' } as RequestInit));
  assert.equal(streamed.status, 413);
  assert.ok(sent <= MAX_ATTACHMENT_BYTES + 2 * chunk.length, `reading stopped at the cap, after ${sent} bytes`);

  // A real image a little under the cap goes through, and what is stored is under the cap too.
  const big = await noisePng(1100, 1100);
  assert.ok(big.length > 3 * 1024 * 1024 && big.length <= MAX_ATTACHMENT_BYTES, `the fixture is ${big.length} bytes`);
  const stored = await uploaded(big, 'david');
  assert.ok(stored.bytes <= MAX_ATTACHMENT_BYTES);

  // A small file that unpacks into a huge picture is refused as well.
  const bomb = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.ok(bomb.length < 1024 * 1024);
  const refused = await upload(bomb, 'david');
  assert.equal(refused.status, 413);
  assert.match(await errorOf(refused), /million pixels/);
});

test('a message links its sender\'s uploads; they come back in the list and the export', async () => {
  const a = await uploaded(await png(40, 20), 'david');
  const b = await uploaded(await jpeg(64, 48), 'david');
  // Text may be empty when there is an image. The order given is the order kept.
  const res = await post({ text: '', attachments: [b.id, a.id] }, 'david');
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments, [b, a]);
  for (const att of message.attachments) assert.deepEqual(Object.keys(att).sort(), ['bytes', 'content_type', 'height', 'id', 'scale', 'width']);

  const seen = (await list('grok')).find((m) => m.id === message.id);
  assert.deepEqual(seen?.attachments, [b, a], 'another participant sees the same attachments');
  assert.equal((await download(a.id, 'grok')).status, 200, 'and can fetch the image');

  const md = await (await exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth('claude') }))).text();
  assert.ok(md.includes(`[image: ${b.id}, 64×48]`) && md.includes(`[image: ${a.id}, 40×20]`), 'the export names each image');
  assert.ok(!md.includes('data:image'), 'and carries no image bytes');

  const withText = await post({ text: 'see the screenshot', attachments: [(await uploaded(await png(), 'david')).id] }, 'david');
  assert.equal(((await withText.json()) as { message: Message }).message.attachments.length, 1);
});

test('no linking someone else\'s upload, an upload that is already linked, or one that does not exist', async () => {
  const davids = await uploaded(await png(), 'david');
  const before = (await list()).length;

  const stolen = await post({ text: 'mine now', attachments: [davids.id] }, 'claude');
  assert.equal(stolen.status, 403);
  assert.match(await errorOf(stolen), /someone else/);

  const claudes = await uploaded(await png(), 'claude');
  assert.equal((await post({ text: 'one of each', attachments: [claudes.id, davids.id] }, 'claude')).status, 403);
  assert.equal((await post({ text: 'ghost', attachments: ['att_0123456789abcdef01234567'] }, 'david')).status, 404);
  assert.equal((await list()).length, before, 'none of the refused messages was stored');

  // The refusals left both uploads unlinked, so their owners can still use them. Once.
  assert.equal((await post({ text: 'first use', attachments: [davids.id] }, 'david')).status, 201);
  assert.equal((await post({ text: 'first use', attachments: [claudes.id] }, 'claude')).status, 201);
  const again = await post({ text: 'second use', attachments: [davids.id] }, 'david');
  assert.equal(again.status, 409);
  assert.match(await errorOf(again), /already belongs to a message/);
  assert.equal((await list()).length, before + 2);
});

test('at most 4 attachments per message, and the list must be well-formed', async () => {
  const ids = ['att_aaaaaaaaaaaaaaaaaaaaaaa1', 'att_aaaaaaaaaaaaaaaaaaaaaaa2', 'att_aaaaaaaaaaaaaaaaaaaaaaa3', 'att_aaaaaaaaaaaaaaaaaaaaaaa4', 'att_aaaaaaaaaaaaaaaaaaaaaaa5'];
  const five = await post({ text: 'too many', attachments: ids }, 'david');
  assert.equal(five.status, 400);
  assert.match(await errorOf(five), /at most 4/);
  assert.equal((await post({ text: 'twice', attachments: [ids[0], ids[0]] }, 'david')).status, 400);
  assert.equal((await post({ text: 'not a list', attachments: ids[0] }, 'david')).status, 400);
  assert.equal((await post({ text: 'not an id', attachments: ['../../etc/passwd'] }, 'david')).status, 400);
  assert.equal((await post({ text: 'not strings', attachments: [1, 2] }, 'david')).status, 400);

  // Four is fine.
  const four: string[] = [];
  for (let i = 0; i < 4; i++) four.push((await uploaded(await png(8 + i, 8), 'claude')).id);
  const res = await post({ text: 'four', attachments: four }, 'claude');
  assert.equal(res.status, 201);
  assert.deepEqual(((await res.json()) as { message: Message }).message.attachments.map((a) => a.id), four);
});

test('an upload stays private to its uploader until a message links it', async () => {
  const a = await uploaded(await png(), 'david');
  assert.equal((await download(a.id, 'david')).status, 200);
  assert.equal((await download(a.id, 'claude')).status, 404);
  await post({ text: 'now shared', attachments: [a.id] }, 'david');
  assert.equal((await download(a.id, 'claude')).status, 200);
  assert.equal((await download('att_0123456789abcdef01234567', 'david')).status, 404);
  assert.equal((await download('not-an-id', 'david')).status, 404);
});

test('old clients that never send "attachments" still work', async () => {
  const res = await post({ text: 'plain text, as before' }, 'david');
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.deepEqual(message.attachments, [], 'new field, empty');
  assert.deepEqual(Object.keys(message).sort(), ['attachments', 'created_at', 'id', 'pinned_at', 'recipient', 'sender', 'text']);
  // Text is still required when there is no image.
  assert.equal((await post({ text: '' }, 'david')).status, 400);
  assert.equal((await post({}, 'david')).status, 400);
  assert.equal((await post({ text: '', attachments: [] }, 'david')).status, 400);
  assert.equal((await post({ text: 'empty list is fine', attachments: [] }, 'david')).status, 201);
  assert.equal((await post({ text: 'so is null', attachments: null }, 'david')).status, 201);
  assert.ok((await list()).every((m) => Array.isArray(m.attachments)), 'every message in the list has the field');
});

test('uploads are limited to 20 per sender per hour', async () => {
  // Grok has uploaded nothing in this file so far.
  const tiny = await png(4, 4);
  for (let i = 0; i < 20; i++) assert.equal((await upload(tiny, 'grok')).status, 201, `upload ${i + 1}`);
  const limited = await upload(tiny, 'grok');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match(await errorOf(limited), /20 image uploads per hour/);
  assert.equal((await upload(tiny, 'claude')).status, 201, 'another sender is not affected');
});

test('a sender over the limit is refused before the image is decoded', async () => {
  // Runs after the test above: Grok is over the limit, Claude and the third sender are not.
  // These two bodies only show what they are when a decoder opens them. Under the limit that
  // gives 400 (damaged) and 413 (too many pixels) ...
  const damaged = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not a real PNG after the first eight bytes')]);
  const bomb = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal((await upload(damaged, 'claude')).status, 400);
  assert.equal((await upload(bomb, 'claude')).status, 413);
  // ... and over the limit both get 429, so nothing looked inside them.
  for (const body of [damaged, bomb]) {
    const res = await upload(body, 'grok');
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  }
  // The checks that cost nothing still come first, limit or not.
  assert.equal((await upload('<html>not an image</html>', 'grok', { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await upload('', 'grok')).status, 400);
  const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal((await upload(tooBig, 'grok')).status, 413);
});
