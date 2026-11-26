// The message box, as far as it can be checked without a browser: how tall it should be, the
// unsent draft in storage, and the expand button's markup. Measuring real text, the scroll
// position of the stream and the layout need a browser and are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXPANDED_SHARE, ExpandButton, GROW_SHARE, MAX_DRAFT_CHARS, MIN_BOX_HEIGHT, boxSize, draftFor, draftKey, readDraft, writeDraft } from '../app/composer';

const LINE = 22.5; // one line of text in the box
const lines = (n: number) => Math.ceil(n * LINE + 14); // text plus padding and border

test('the box grows with its text, line by line, up to 40% of the window, then scrolls', () => {
  const window = 1000;
  assert.deepEqual(boxSize(lines(1), window, false), { height: MIN_BOX_HEIGHT, scrolls: false }, 'empty or one line: the smallest size');
  assert.deepEqual(boxSize(lines(2), window, false), { height: MIN_BOX_HEIGHT, scrolls: false });
  const heights = [3, 4, 5, 10].map((n) => boxSize(lines(n), window, false));
  assert.deepEqual(heights.map((h) => h.height), [3, 4, 5, 10].map(lines), 'exactly as tall as the text');
  assert.ok(heights.every((h) => !h.scrolls), 'no scroll bar while it still grows');
  // 50 lines need far more than 40% of the window.
  assert.deepEqual(boxSize(lines(50), window, false), { height: window * GROW_SHARE, scrolls: true });
  assert.deepEqual(boxSize(window * GROW_SHARE, window, false), { height: 400, scrolls: false }, 'exactly at the limit: fits');
  assert.deepEqual(boxSize(window * GROW_SHARE + 30, window, false), { height: 400, scrolls: true });
  // After sending the text is gone and the box is small again.
  assert.equal(boxSize(lines(0), window, false).height, MIN_BOX_HEIGHT);
});

test('expanded: a tall writing area of 60% of the window, whatever the text', () => {
  assert.deepEqual(boxSize(lines(1), 1000, true), { height: 1000 * EXPANDED_SHARE, scrolls: false });
  assert.deepEqual(boxSize(lines(20), 1000, true), { height: 600, scrolls: false });
  assert.deepEqual(boxSize(lines(50), 1000, true), { height: 600, scrolls: true });
  assert.ok(boxSize(lines(1), 1000, true).height > boxSize(lines(50), 1000, false).height, 'taller than the growing box can get');
});

test('a small window, or a phone with its keyboard open, still gets a usable box', () => {
  // 300 px left above an on-screen keyboard: 40% is 120 px, 60% is 180 px.
  assert.deepEqual(boxSize(lines(50), 300, false), { height: 120, scrolls: true });
  assert.deepEqual(boxSize(lines(50), 300, true), { height: 180, scrolls: true });
  // Never smaller than the smallest size, even in a window that is hardly there.
  assert.equal(boxSize(lines(50), 100, false).height, MIN_BOX_HEIGHT);
  assert.equal(boxSize(lines(50), 80, true).height, MIN_BOX_HEIGHT);
  assert.equal(boxSize(lines(1), 0, false).height, MIN_BOX_HEIGHT);
});

/** A stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test('an unsent draft is kept per participant and removed when it is sent', () => {
  const storage = memoryStorage();
  writeDraft(storage, 'claude', 'half a thought\nsecond line');
  writeDraft(storage, 'grok', 'another one');
  assert.equal(readDraft(storage, 'claude'), 'half a thought\nsecond line');
  assert.equal(readDraft(storage, 'grok'), 'another one');
  assert.deepEqual([...storage.map.keys()].sort(), [draftKey('claude'), draftKey('grok')], 'one entry each, and nothing else');
  // Sending empties the box, which removes the entry rather than storing an empty one.
  writeDraft(storage, 'claude', '');
  assert.equal(storage.map.has(draftKey('claude')), false);
  assert.equal(readDraft(storage, 'claude'), '');
  assert.equal(readDraft(storage, 'grok'), 'another one', 'the other participant is untouched');
  writeDraft(storage, 'grok', '  \n ');
  assert.equal(storage.map.size, 0, 'only spaces is nothing worth keeping');
});

test('draft storage never breaks the box: oversized text and a storage that refuses', () => {
  const storage = memoryStorage();
  writeDraft(storage, 'claude', 'kept');
  writeDraft(storage, 'claude', 'x'.repeat(MAX_DRAFT_CHARS + 1));
  assert.equal(storage.map.size, 0, 'too long to ever be sent: not kept, and the older draft is not left behind as if current');
  assert.equal(readDraft(memoryStorage({ [draftKey('claude')]: 'y'.repeat(MAX_DRAFT_CHARS + 1) }), 'claude'), '');
  const refusing = {
    getItem: () => { throw new Error('storage is off'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('storage is off'); },
  };
  assert.equal(readDraft(refusing, 'claude'), '');
  assert.doesNotThrow(() => writeDraft(refusing, 'claude', 'text'));
  assert.doesNotThrow(() => writeDraft(refusing, 'claude', ''));
});

test('whose draft the box shows once the page knows who is signed in', () => {
  // After a reload: the box is empty and the stored draft comes back.
  assert.equal(draftFor('', null, 'claude', 'stored text'), 'stored text');
  assert.equal(draftFor('', null, 'claude', ''), '');
  // Text typed in the first moment, before the page knew who is signed in, wins over the stored draft.
  assert.equal(draftFor('typed at once', null, 'claude', 'stored text'), 'typed at once');
  assert.equal(draftFor('   ', null, 'claude', 'stored text'), 'stored text', 'spaces alone do not count as typing');
  // The same participant again (a reconnect): the box is left alone.
  assert.equal(draftFor('still writing', 'claude', 'claude', 'older stored text'), 'still writing');
  assert.equal(draftFor('', 'claude', 'claude', 'older stored text'), '');
  // Another participant signs in at the same browser: never the previous one's text.
  assert.equal(draftFor('text of the first', 'claude', 'grok', 'text of the second'), 'text of the second');
  assert.equal(draftFor('text of the first', 'claude', 'grok', ''), '');
});

test('the expand button says what it does and which state it is in', () => {
  const off = renderToStaticMarkup(<ExpandButton expanded={false} onToggle={() => {}} className="b" />);
  assert.match(off, /^<button type="button" class="b" aria-label="Enlarge the message box" aria-pressed="false" title="Enlarge the message box">/);
  const on = renderToStaticMarkup(<ExpandButton expanded={true} onToggle={() => {}} className="b" />);
  assert.match(on, /aria-label="Shrink the message box" aria-pressed="true"/);
  for (const out of [off, on]) {
    assert.match(out, /<svg aria-hidden="true"/, 'the drawing is hidden from screen readers; the label speaks');
    assert.ok(!/<img|href=|url\(|https?:/.test(out.replace('http://www.w3.org/2000/svg', '')), 'drawn in place, nothing loaded');
  }
  assert.notEqual(off.match(/ d="([^"]+)"/)?.[1], on.match(/ d="([^"]+)"/)?.[1], 'the two states look different');
});
