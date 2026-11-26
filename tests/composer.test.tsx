// The message box, as far as it can be checked without a browser: how tall it should be, the
// unsent draft in storage, and the expand button's markup. Measuring real text, the scroll
// position of the stream and the layout need a browser and are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTools, EMPTY_DRAFT, EXPANDED_SHARE, ExpandButton, GROW_SHARE, MAX_DRAFT_CHARS, MIN_BOX_HEIGHT, boxSize, draftFor, draftKey, readDraft, writeDraft } from '../app/composer';

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

const text = (t: string) => ({ text: t, quotes: [] });
const quote = { author: 'Grok', messageId: 45, kind: 'selection' as const, text: 'the quoted words' };
const whole = { author: 'Claude', messageId: 46, kind: 'message' as const, text: '- a list\n- in Markdown' };

test('an unsent draft is kept per participant and removed when it is sent', () => {
  const storage = memoryStorage();
  writeDraft(storage, 'claude', text('half a thought\nsecond line'));
  writeDraft(storage, 'grok', text('another one'));
  assert.deepEqual(readDraft(storage, 'claude'), text('half a thought\nsecond line'));
  assert.deepEqual(readDraft(storage, 'grok'), text('another one'));
  assert.deepEqual([...storage.map.keys()].sort(), [draftKey('claude'), draftKey('grok')], 'one entry each, and nothing else');
  assert.equal(storage.map.get(draftKey('grok')), 'another one', 'a draft without quotes is stored as its plain text, as before');
  // Sending empties the composer, which removes the entry rather than storing an empty one.
  writeDraft(storage, 'claude', EMPTY_DRAFT);
  assert.equal(storage.map.has(draftKey('claude')), false);
  assert.deepEqual(readDraft(storage, 'claude'), EMPTY_DRAFT);
  assert.deepEqual(readDraft(storage, 'grok'), text('another one'), 'the other participant is untouched');
  writeDraft(storage, 'grok', text('  \n '));
  assert.equal(storage.map.size, 0, 'only spaces is nothing worth keeping');
});

test('quotes are kept with the draft, in the same entry, and cleared with it', () => {
  const storage = memoryStorage();
  writeDraft(storage, 'claude', { text: 'my answer', quotes: [quote, whole] });
  assert.equal(storage.map.size, 1, 'still one entry per participant');
  assert.deepEqual(readDraft(storage, 'claude'), { text: 'my answer', quotes: [quote, whole] }, 'text, quotes and their order come back');
  // Quotes alone are worth keeping: the text field may still be empty.
  writeDraft(storage, 'grok', { text: '', quotes: [quote] });
  assert.deepEqual(readDraft(storage, 'grok'), { text: '', quotes: [quote] });
  // What the page adds to a quote for its own use (a key) is not stored.
  writeDraft(storage, 'grok', { text: '', quotes: [{ ...quote, key: 7 } as typeof quote] });
  assert.ok(!String(storage.map.get(draftKey('grok'))).includes('"key"'));
  // Sent: text and quotes are gone together.
  writeDraft(storage, 'claude', EMPTY_DRAFT);
  assert.equal(storage.map.has(draftKey('claude')), false);
  // Only the message text and the quotes are stored: no token, no images.
  assert.deepEqual(Object.keys(JSON.parse(String(storage.map.get(draftKey('grok'))))).sort(), ['quotes', 'text', 'v']);
});

test('what comes out of storage is checked: an old plain draft, a broken one, a tampered one', () => {
  // A draft stored before quotes existed is plain text, and is read as that.
  assert.deepEqual(readDraft(memoryStorage({ [draftKey('claude')]: 'written last week' }), 'claude'), text('written last week'));
  // Plain text that merely looks a little like the new format stays plain text.
  for (const plain of ['{"v":1, not json at all', '{"v":1,"text":5}', '{"v":2,"text":"x","quotes":[]}', '{"text":"x"}', '[1,2,3]']) {
    assert.deepEqual(readDraft(memoryStorage({ [draftKey('claude')]: plain }), 'claude'), text(plain), plain);
  }
  // Quotes that are not quotes are dropped one by one; the rest and the text survive.
  const tampered = JSON.stringify({ v: 1, text: 'kept', quotes: [quote, { author: '', messageId: 1, kind: 'selection', text: 'x' }, { author: 'Grok', messageId: -4, kind: 'selection', text: 'x' },
    { author: 'Grok', messageId: 2, kind: 'html', text: '<img src=x>' }, { author: 'Grok', messageId: 3, kind: 'message', text: '   ' }, 'a string', null, quote, whole] });
  assert.deepEqual(readDraft(memoryStorage({ [draftKey('claude')]: tampered }), 'claude'), { text: 'kept', quotes: [quote, whole] });
  // Never more than five quotes, whatever is stored.
  const many = JSON.stringify({ v: 1, text: '', quotes: Array.from({ length: 9 }, (_, n) => ({ ...quote, messageId: n + 1 })) });
  assert.equal(readDraft(memoryStorage({ [draftKey('claude')]: many }), 'claude').quotes.length, 5);
});

test('draft storage never breaks the composer: oversized drafts and a storage that refuses', () => {
  const storage = memoryStorage();
  writeDraft(storage, 'claude', text('kept'));
  writeDraft(storage, 'claude', text('x'.repeat(MAX_DRAFT_CHARS + 1)));
  assert.equal(storage.map.size, 0, 'too long to ever be sent: not kept, and the older draft is not left behind as if current');
  assert.deepEqual(readDraft(memoryStorage({ [draftKey('claude')]: 'y'.repeat(MAX_DRAFT_CHARS + 1) }), 'claude'), EMPTY_DRAFT);
  writeDraft(storage, 'claude', { text: 'kept', quotes: [{ ...quote, text: 'z'.repeat(4 * MAX_DRAFT_CHARS) }] });
  assert.equal(storage.map.size, 0, 'a quote far too long to send is not kept either');
  const refusing = {
    getItem: () => { throw new Error('storage is off'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('storage is off'); },
  };
  assert.deepEqual(readDraft(refusing, 'claude'), EMPTY_DRAFT);
  assert.doesNotThrow(() => writeDraft(refusing, 'claude', { text: 'text', quotes: [quote] }));
  assert.doesNotThrow(() => writeDraft(refusing, 'claude', EMPTY_DRAFT));
});

test('whose draft the composer shows once the page knows who is signed in', () => {
  const stored = { text: 'stored text', quotes: [quote] };
  // After a reload: the composer is empty and the stored draft comes back, quotes included.
  assert.deepEqual(draftFor(EMPTY_DRAFT, null, 'claude', stored), stored);
  assert.deepEqual(draftFor(EMPTY_DRAFT, null, 'claude', EMPTY_DRAFT), EMPTY_DRAFT);
  // Something typed or quoted in the first moment, before the page knew who is signed in, wins.
  const typed = text('typed at once');
  assert.equal(draftFor(typed, null, 'claude', stored), typed);
  const quotedAtOnce = { text: '', quotes: [whole] };
  assert.equal(draftFor(quotedAtOnce, null, 'claude', stored), quotedAtOnce);
  assert.deepEqual(draftFor(text('   '), null, 'claude', stored), stored, 'spaces alone do not count as typing');
  // The same participant again (a reconnect): the composer is left alone.
  const writing = text('still writing');
  assert.equal(draftFor(writing, 'claude', 'claude', stored), writing);
  assert.equal(draftFor(EMPTY_DRAFT, 'claude', 'claude', stored), EMPTY_DRAFT);
  // Another participant signs in at the same browser: never the previous one's text or quotes.
  const first = { text: 'text of the first', quotes: [quote] };
  const second = { text: 'text of the second', quotes: [whole] };
  assert.deepEqual(draftFor(first, 'claude', 'grok', second), second);
  assert.deepEqual(draftFor(first, 'claude', 'grok', EMPTY_DRAFT), EMPTY_DRAFT);
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

/** The controls of a piece of markup, in the order they stand in it: each by its label or its text. */
const controls = (markup: string): string[] =>
  [...markup.matchAll(/<(select|button)\b([^>]*)>(.*?)<\/\1>/g)].map(([, , attributes, inside]) =>
    attributes.match(/aria-label="([^"]+)"/)?.[1] ?? inside.replace(/<[^>]+>/g, ''));

test('the row under the message box: recipient, then emoji, image, decision, poll, then enlarge and Send', () => {
  const tools = (over: { decisionOpen?: boolean; pollOpen?: boolean; emojiOpen?: boolean } = {}) => renderToStaticMarkup(
    <ComposerTools
      to="" onTo={() => {}} recipients={[{ name: 'ana', label: 'Ana' }, { name: 'quill-2', label: 'Quill-2' }]}
      emoji={{ open: over.emojiOpen ?? false, onOpenChange: () => {}, onInsert: () => {}, boxRef: { current: null } }}
      image={{ disabled: false, onPick: () => {} }}
      decision={{ open: over.decisionOpen ?? false, onToggle: () => {} }}
      poll={{ open: over.pollOpen ?? false, onToggle: () => {} }}
      expand={{ expanded: false, onToggle: () => {} }}
      send={{ disabled: true, label: 'Send' }}
      fieldClassName="f" toolClassName="t"
    />,
  );
  const row = tools();
  // The order on the screen, and the order of the Tab key: the most used action comes first.
  assert.deepEqual(controls(row), ['Recipient', 'Emoji', 'Image', 'Decision', 'Poll', 'Enlarge the message box', 'Send']);
  // Nothing moves a control out of that order for the keyboard, and nothing reorders them on the screen.
  assert.ok(!/tabindex/i.test(row), row);
  assert.ok(!/\border-(first|last|\d+|\[)/.test(row), row);
  assert.ok(!row.includes('flex-row-reverse'), row);
  // The picker offers everyone and each participant; Send is the only button that sends.
  assert.match(row, /<select aria-label="Recipient" class="f"><option value="" selected="">to everyone<\/option><option value="ana">to Ana<\/option><option value="quill-2">to Quill-2<\/option><\/select>/);
  assert.deepEqual([...row.matchAll(/<button type="(\w+)"/g)].map((m) => m[1]), ['button', 'button', 'button', 'button', 'button', 'submit']);
  assert.match(row, /<button type="submit" class="t ml-auto md:ml-0" disabled="">Send<\/button>/);
  // The keyboard hint stands between the actions and Send.
  assert.ok(row.indexOf('Enter sends') > row.indexOf('Enlarge the message box') && row.indexOf('Enter sends') < row.indexOf('>Send<'));
  // Decision and Poll say whether their form is open, and which form that is.
  assert.match(row, /aria-pressed="false" aria-expanded="false">Decision</);
  assert.match(row, /aria-pressed="false" aria-expanded="false">Poll</);
  assert.match(tools({ decisionOpen: true }), /aria-pressed="true" aria-expanded="true" aria-controls="decision-composer">Decision</);
  assert.match(tools({ pollOpen: true }), /aria-pressed="true" aria-expanded="true" aria-controls="poll-composer">Poll</);
  // With the emoji panel open the order of the row's own controls is unchanged; the panel's
  // controls come right after the emoji button.
  const open = controls(tools({ emojiOpen: true }));
  assert.deepEqual(open.slice(0, 2), ['Recipient', 'Emoji']);
  assert.deepEqual(open.slice(-5), ['Image', 'Decision', 'Poll', 'Enlarge the message box', 'Send']);
});
