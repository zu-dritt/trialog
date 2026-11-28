import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Lightbox, MessageImages, type Viewed } from '../app/attachments';
import type { Attachment } from '../lib/shared';

const image = (id: string, width = 400, height = 300): Attachment => ({
  id, content_type: 'image/png', width, height, bytes: 1200, scale: 1,
});
const viewed = (id: string, i: number): Viewed => ({
  url: `blob:local-${i}`, size: image(id), bytes: 1200, saveAs: `${id}.png`,
});
const items: Viewed[] = [viewed('att_aaaaaaaaaaaaaaaaaaaaaaaa', 0), viewed('att_bbbbbbbbbbbbbbbbbbbbbbbb', 1), viewed('att_cccccccccccccccccccccccc', 2), viewed('att_dddddddddddddddddddddddd', 3)];

test('a single image has no arrows and no counter, and still closes the same way', () => {
  const html = renderToStaticMarkup(<Lightbox viewed={items[0]} onClose={() => {}} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Image, full size"/);
  assert.doesNotMatch(html, /data-image-nav/);
  assert.doesNotMatch(html, /data-image-counter/);
  assert.doesNotMatch(html, /data-image-prev/);
  assert.doesNotMatch(html, /Previous image/);
  assert.match(html, />Close</);
});

test('several images show ← → and a «2/4» counter; the ends disable a button', () => {
  const mid = renderToStaticMarkup(<Lightbox items={items} index={1} onIndex={() => {}} onClose={() => {}} />);
  assert.match(mid, /aria-label="Image 2\/4, full size"/);
  assert.match(mid, /data-image-nav/);
  assert.match(mid, /data-image-counter[^>]*>2\/4</);
  assert.match(mid, /aria-label="Previous image"/);
  assert.match(mid, /aria-label="Next image"/);
  assert.doesNotMatch(mid, /data-image-prev="" aria-label="Previous image" disabled=""/);
  assert.doesNotMatch(mid, /data-image-next="" aria-label="Next image" disabled=""/);

  const first = renderToStaticMarkup(<Lightbox items={items} index={0} onIndex={() => {}} onClose={() => {}} />);
  assert.match(first, />1\/4</);
  assert.match(first, /data-image-prev="" aria-label="Previous image" disabled=""/);
  assert.doesNotMatch(first, /data-image-next="" aria-label="Next image" disabled=""/);

  const last = renderToStaticMarkup(<Lightbox items={items} index={3} onIndex={() => {}} onClose={() => {}} />);
  assert.match(last, />4\/4</);
  assert.match(last, /data-image-next="" aria-label="Next image" disabled=""/);
  assert.doesNotMatch(last, /data-image-prev="" aria-label="Previous image" disabled=""/);
});

test('the thumbnails of a message do not open the view until one is pressed', () => {
  const html = renderToStaticMarkup(<MessageImages attachments={[image('att_aaaaaaaaaaaaaaaaaaaaaaaa'), image('att_bbbbbbbbbbbbbbbbbbbbbbbb')]} load={() => Promise.resolve('')} />);
  assert.ok(!html.includes('role="dialog"'));
  assert.equal((html.match(/aria-label="Image,/g) ?? []).length, 2);
});
