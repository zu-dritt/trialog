// The image parts of the page that can be checked without a browser: what is rendered before any
// bytes are fetched, and the size arithmetic. Paste, drop and the canvas need a real browser and
// are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftChips, MessageImages, fetchImage, withoutSent, type Draft } from '../app/attachments';
import { DOWNSIZE_LONG_EDGE, fitWithin, firstLine, type Attachment } from '../lib/shared';

const shot: Attachment = { id: 'att_0123456789abcdef01234567', content_type: 'image/png', width: 1170, height: 2532, bytes: 184322 };
const wide: Attachment = { id: 'att_89abcdef0123456789abcdef', content_type: 'image/jpeg', width: 1600, height: 900, bytes: 90000 };
const never = () => new Promise<string>(() => {});

test('a thumbnail never points an <img> at the API: the address alone carries no token', () => {
  const out = renderToStaticMarkup(<MessageImages attachments={[shot, wide]} load={never} />);
  assert.ok(!out.includes('<img'), 'no image element until the bytes were fetched with the token');
  assert.ok(!out.includes('/api/attachments'), 'and no address of the API anywhere in the markup');
  assert.equal((out.match(/<button/g) ?? []).length, 2, 'one placeholder per image');
  assert.match(out, /aria-label="Image, 1170×2532"/);
  // The placeholder already has the image's shape, so the stream does not jump when it loads.
  assert.match(out, /width:111px;aspect-ratio:1170 \/ 2532/);
  assert.match(out, /width:320px;aspect-ratio:1600 \/ 900/);
});

test('a message without images renders nothing extra', () => {
  assert.equal(renderToStaticMarkup(<MessageImages attachments={[]} load={never} />), '');
});

test('preview chips show the state of each upload and have a remove button', () => {
  const drafts: Draft[] = [
    { key: 1, name: 'a.png', preview: 'blob:local-1', state: 'uploading' },
    { key: 2, name: 'b.png', preview: 'blob:local-2', state: 'ready', attachment: shot },
    { key: 3, name: 'c.gif', preview: 'blob:local-3', state: 'failed', error: 'Only PNG, JPEG and WebP images are accepted.' },
  ];
  const out = renderToStaticMarkup(<DraftChips drafts={drafts} onRemove={() => {}} />);
  assert.equal((out.match(/<li[ >]/g) ?? []).length, 3);
  assert.match(out, /uploading…/);
  assert.match(out, /1170×2532/);
  assert.match(out, /Only PNG, JPEG and WebP/);
  for (const name of ['a.png', 'b.png', 'c.gif']) assert.ok(out.includes(`aria-label="Remove image ${name}"`));
  assert.deepEqual(out.match(/src="[^"]*"/g), ['src="blob:local-1"', 'src="blob:local-2"', 'src="blob:local-3"'], 'previews are local blob: URLs');
  assert.equal(renderToStaticMarkup(<DraftChips drafts={[]} onRemove={() => {}} />), '');
});

test('fitWithin keeps the shape, never enlarges, and brings the long edge to the limit', () => {
  assert.deepEqual(fitWithin(4000, 3000, DOWNSIZE_LONG_EDGE, DOWNSIZE_LONG_EDGE), { width: 2560, height: 1920 });
  assert.deepEqual(fitWithin(3000, 4000, DOWNSIZE_LONG_EDGE, DOWNSIZE_LONG_EDGE), { width: 1920, height: 2560 });
  assert.deepEqual(fitWithin(1170, 2532, DOWNSIZE_LONG_EDGE, DOWNSIZE_LONG_EDGE), { width: 1170, height: 2532 }, 'already small enough');
  assert.deepEqual(fitWithin(1170, 2532, 320, 240), { width: 111, height: 240 });
  assert.deepEqual(fitWithin(20000, 10, 2560, 2560), { width: 2560, height: 1 }, 'never less than one pixel');
  assert.deepEqual(fitWithin(8, 8, 320, 240), { width: 8, height: 8 });
});

test('firstLine names the images of a message that has no text', () => {
  assert.equal(firstLine({ text: '  DECISION: go\nmore', attachments: [shot] }, 160), 'DECISION: go');
  assert.equal(firstLine({ text: '', attachments: [shot] }, 160), '[image: att_0123456789abcdef01234567, 1170×2532]');
  assert.equal(firstLine({ text: '' }, 160), '', 'a message from a server that does not send the field yet');
});

test('an image request that answers 401 sends the reader back to the token prompt', async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const answering = (status: number, body = 'x') => (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return new Response(body, { status });
  }) as typeof fetch;
  let forgotten = 0;
  const forget = () => { forgotten += 1; };

  await assert.rejects(fetchImage(shot.id, 'a-token-that-stopped-working', forget, answering(401)), /unauthorized/);
  assert.equal(forgotten, 1, 'the page is told, as it is when a message request gets 401');

  // Any other failure is just a thumbnail that did not load: the token is kept.
  for (const status of [404, 429, 500]) await assert.rejects(fetchImage(shot.id, 'good-token', forget, answering(status)), new RegExp(`HTTP ${status}`));
  assert.equal(forgotten, 1);

  const blob = await fetchImage(shot.id, 'good-token', forget, answering(200, 'image bytes'));
  assert.equal(await blob.text(), 'image bytes');
  assert.equal(forgotten, 1);
  assert.deepEqual(calls.at(-1), { url: `/api/attachments/${shot.id}`, authorization: 'Bearer good-token' }, 'the token travels in the header, never in the address');
});

test('after a send, only the images that went out leave the composer', () => {
  const draft = (key: number, state: Draft['state'] = 'ready'): Draft => ({ key, name: `${key}.png`, preview: `blob:local-${key}`, state, attachment: state === 'ready' ? shot : undefined });
  const sent = [draft(1), draft(2)];
  // While the message was on its way, a third image was dropped and a fourth is still uploading.
  const now = [...sent, draft(3), draft(4, 'uploading')];
  assert.deepEqual(withoutSent(now, sent).map((d) => d.key), [3, 4]);
  assert.deepEqual(withoutSent(sent, sent), [], 'nothing was added: the composer is empty, as before');
  assert.deepEqual(withoutSent([draft(2), draft(5)], sent).map((d) => d.key), [5], 'a sent image that was already removed by hand is no problem');
  // An upload that failed before the send did not go out, so it stays where the reader can see it.
  const failed = draft(6, 'failed');
  assert.deepEqual(withoutSent([...sent, failed], sent), [failed]);
  assert.deepEqual(withoutSent(now, []).map((d) => d.key), [1, 2, 3, 4], 'a text-only message takes no image with it');
});
