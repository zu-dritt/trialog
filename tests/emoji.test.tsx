// The emoji picker, as far as it can be checked without a browser: the list itself, the search,
// inserting at the cursor, the list of recent emojis, and what the panel renders. Clicking,
// focus and the arrow keys need a real browser and are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmojiPanel, EmojiPicker, PANEL_HEIGHT, PANEL_MIN_HEIGHT, RECENT_MAX, insertAtCursor, panelHeight, parseRecent, pushRecent, searchEmojis } from '../app/emoji';
import { ALL_EMOJIS, EMOJI_GROUPS } from '../app/emoji-data';

const chars = (query: string) => searchEmojis(query).map((e) => e.char);
const THUMBS_UP = '👍';
const ROCKET = '🚀';
const HEART = '❤️';

test('the list: a few groups, 150 to 250 emojis, each one a single named emoji with words to search', () => {
  assert.deepEqual(EMOJI_GROUPS.map((g) => g.id), ['faces', 'gestures', 'nature', 'food', 'activities', 'objects', 'symbols']);
  assert.ok(ALL_EMOJIS.length >= 150 && ALL_EMOJIS.length <= 250, `${ALL_EMOJIS.length} emojis`);
  assert.equal(new Set(ALL_EMOJIS.map((e) => e.char)).size, ALL_EMOJIS.length, 'no emoji twice');
  assert.equal(new Set(ALL_EMOJIS.map((e) => e.name)).size, ALL_EMOJIS.length, 'no name twice');
  const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const e of ALL_EMOJIS) {
    assert.equal([...graphemes.segment(e.char)].length, 1, `${e.name} is one character on screen`);
    assert.match(e.char, /\p{Extended_Pictographic}/u, `${e.name} is an emoji`);
    // A sign like the heart or the arrows is a plain text character unless it says otherwise.
    const first = String.fromCodePoint(e.char.codePointAt(0) as number);
    if (!/^\p{Emoji_Presentation}/u.test(first) && !e.char.includes('‍')) assert.ok(e.char.includes('️'), `${e.name} asks for the colour glyph`);
    assert.ok(e.name.trim().length > 2, `${e.char} has a name`);
    assert.ok(e.words.length >= 3, `${e.name} has a few words to find it by`);
    assert.ok(e.words.every((w) => /^[a-z0-9]+$/.test(w)), `${e.name}: words are lower-case and plain`);
  }
  for (const g of EMOJI_GROUPS) assert.ok(g.emojis.length >= 10 && g.label, g.id);
});

test('search: every word typed must start a word of the emoji', () => {
  assert.ok(chars('thumbs').includes(THUMBS_UP));
  assert.deepEqual(chars('thumbs up'), [THUMBS_UP]);
  assert.deepEqual(chars('THUM  UP '), [THUMBS_UP], 'case, extra spaces and unfinished words');
  assert.ok(chars('approve').includes(THUMBS_UP), 'a keyword that is not in the name');
  assert.ok(chars('deploy').includes(ROCKET) && chars('launch').includes(ROCKET));
  assert.ok(chars('heart').length >= 7, 'all the hearts');
  // The start of a word, not any part of it: "car" finds the car and the carrot, not "scared".
  assert.ok(chars('car').includes('🚗'));
  assert.ok(!chars('car').includes('😱'));
  assert.deepEqual(chars('thumbs rocket'), [], 'both words must match the same emoji');
  assert.deepEqual(chars('qqqq'), []);
});

test('search: empty input matches nothing, an emoji finds itself, odd input is harmless', () => {
  assert.deepEqual(chars(''), []);
  assert.deepEqual(chars('   '), []);
  assert.deepEqual(chars(ROCKET), [ROCKET]);
  assert.deepEqual(chars(` ${HEART} `), [HEART]);
  for (const odd of ['.*', '(', '\\', '<script>', '💩💩💩', '%']) assert.deepEqual(chars(odd), [], odd);
});

test('insertAtCursor: at the cursor, over a selection, at both ends', () => {
  assert.deepEqual(insertAtCursor('hello world', 5, 5, ROCKET), { text: `hello${ROCKET} world`, cursor: 5 + ROCKET.length });
  assert.deepEqual(insertAtCursor('hello world', 6, 11, THUMBS_UP), { text: `hello ${THUMBS_UP}`, cursor: 6 + THUMBS_UP.length }, 'a selection is replaced');
  assert.deepEqual(insertAtCursor('', 0, 0, HEART), { text: HEART, cursor: HEART.length });
  assert.deepEqual(insertAtCursor('abc', 0, 0, ROCKET), { text: `${ROCKET}abc`, cursor: ROCKET.length });
  assert.deepEqual(insertAtCursor('abc', 3, 3, ROCKET), { text: `abc${ROCKET}`, cursor: 3 + ROCKET.length });
  assert.deepEqual(insertAtCursor('abc', 0, 3, ROCKET), { text: ROCKET, cursor: ROCKET.length }, 'everything selected');
  assert.deepEqual(insertAtCursor('line one\nline two', 8, 8, ROCKET).text, `line one${ROCKET}\nline two`);
});

test('insertAtCursor: several in a row, and positions that make no sense', () => {
  // Picking three in a row: each goes in behind the one before.
  let state = { text: 'go ', cursor: 3 };
  for (const emoji of [ROCKET, HEART, THUMBS_UP]) state = insertAtCursor(state.text, state.cursor, state.cursor, emoji);
  assert.equal(state.text, `go ${ROCKET}${HEART}${THUMBS_UP}`);
  assert.equal(state.cursor, state.text.length);
  // A selection made from right to left, and positions outside the text, never lose or duplicate text.
  assert.deepEqual(insertAtCursor('hello world', 11, 6, 'X'), { text: 'hello X', cursor: 7 });
  assert.deepEqual(insertAtCursor('abc', 99, 99, 'X'), { text: 'abcX', cursor: 4 });
  assert.deepEqual(insertAtCursor('abc', -5, -5, 'X'), { text: 'Xabc', cursor: 1 });
  // An emoji already in the text is two code units long; a cursor behind it stays behind it.
  const before = `${ROCKET}ab`;
  assert.equal(insertAtCursor(before, ROCKET.length, ROCKET.length, HEART).text, `${ROCKET}${HEART}ab`);
});

test('recent emojis: newest first, each once, capped', () => {
  assert.deepEqual(pushRecent([], ROCKET), [ROCKET]);
  assert.deepEqual(pushRecent([ROCKET], HEART), [HEART, ROCKET]);
  assert.deepEqual(pushRecent([HEART, ROCKET, THUMBS_UP], THUMBS_UP), [THUMBS_UP, HEART, ROCKET], 'used again: moves to the front, not listed twice');
  let list: string[] = [];
  for (const e of ALL_EMOJIS.slice(0, RECENT_MAX + 5)) list = pushRecent(list, e.char);
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0], ALL_EMOJIS[RECENT_MAX + 4].char, 'the newest is first');
  assert.ok(!list.includes(ALL_EMOJIS[0].char), 'the oldest fell off');
  assert.deepEqual(pushRecent([HEART, ROCKET, THUMBS_UP], '🎉', 2), ['🎉', HEART]);
});

test('recent emojis: what comes out of storage is checked', () => {
  assert.deepEqual(parseRecent(JSON.stringify([ROCKET, HEART])), [ROCKET, HEART]);
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent(''), []);
  assert.deepEqual(parseRecent('not json'), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent(JSON.stringify([ROCKET, ROCKET, HEART])), [ROCKET, HEART], 'no doubles');
  // Only emojis from our own list are shown: other text in storage never reaches the page.
  assert.deepEqual(parseRecent(JSON.stringify(['<img src=x onerror=alert(1)>', 'some text', 7, null, ROCKET, '💩'])), [ROCKET]);
  assert.equal(parseRecent(JSON.stringify(ALL_EMOJIS.map((e) => e.char))).length, RECENT_MAX);
});

test('the panel: a labelled dialog with a search field and one named button per emoji', () => {
  const out = renderToStaticMarkup(<EmojiPanel id="p" recent={[ROCKET, THUMBS_UP]} onPick={() => {}} />);
  assert.match(out, /role="dialog" aria-label="Emoji"/);
  assert.match(out, /<input[^>]*type="search"[^>]*aria-label="Search emoji"/);
  const buttons = out.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, ALL_EMOJIS.length + 2, 'every emoji, plus the two recent ones');
  for (const b of buttons) {
    assert.match(b, /type="button"/, 'never a submit button: a pick must not send the message');
    assert.match(b, /aria-label="[^"]{3,}"/, 'named for screen readers');
    assert.match(b, /data-emoji="[^"]+"/);
  }
  assert.ok(out.includes(`aria-label="thumbs up" title="thumbs up"`));
  // The groups are named, with "Recently used" first.
  const groups = [...out.matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['Recently used', ...EMOJI_GROUPS.map((g) => g.label.replace('&', '&amp;'))]);
  // The grid is one stop for the Tab key; the arrow keys move inside it.
  assert.equal((out.match(/tabindex="0"/g) ?? []).length, 1);
  assert.equal((out.match(/tabindex="-1"/g) ?? []).length, buttons.length - 1);
  // Text only: no image, and nothing that points at another site.
  assert.ok(!/<img|<svg|<link|url\(|https?:/.test(out));
});

test('the panel has one height, whatever it shows', () => {
  // Enough room: the full height. Less room: what there is, but never squeezed to nothing.
  assert.equal(PANEL_HEIGHT, 352);
  assert.equal(panelHeight(900), PANEL_HEIGHT);
  assert.equal(panelHeight(PANEL_HEIGHT), PANEL_HEIGHT);
  assert.equal(panelHeight(300), 300);
  assert.equal(panelHeight(40), PANEL_MIN_HEIGHT);
  // Before the room is known: the full height, or half the window if that is less.
  assert.equal(panelHeight(undefined), 'min(352px, 50vh)');

  /** The parts that decide the size: the panel's own tag, the search field's holder, and the list's holder. */
  const frame = (out: string) => {
    const panel = /^<div[^>]*role="dialog"[^>]*>/.exec(out)?.[0] ?? '';
    const [field, list] = [...out.matchAll(/<div class="([^"]*)">(?=<input)|<div class="([^"]*overflow-y-auto[^"]*)">/g)].map((m) => m[1] ?? m[2]);
    return { panel, field, list };
  };
  const full = renderToStaticMarkup(<EmojiPanel id="p" maxHeight={900} recent={[ROCKET, THUMBS_UP]} onPick={() => {}} />);
  const { panel, field, list } = frame(full);
  // A height, not a largest height: a short list must not make the panel shorter.
  assert.match(panel, /style="height:352px"/);
  assert.ok(!full.includes('max-height'), 'nothing in the panel sizes itself by its content');
  assert.match(panel, /class="[^"]*\bflex\b[^"]*\bflex-col\b/);
  // The search field keeps its own height at the top; the list takes the rest and scrolls inside it.
  assert.ok(field.split(' ').includes('flex-none'), field);
  for (const c of ['min-h-0', 'flex-1', 'overflow-y-auto', '[scrollbar-gutter:stable]']) assert.ok(list.split(' ').includes(c), c);
  // The field is in front of the list and not inside it, so it cannot scroll away or move.
  assert.ok(full.indexOf('type="search"') < full.indexOf('overflow-y-auto'));
  assert.ok(!full.slice(full.indexOf('overflow-y-auto')).includes('type="search"'));

  // The same frame with everything, without the "Recently used" row, with a few matches and with none.
  const views = {
    'no recent row': <EmojiPanel id="p" maxHeight={900} recent={[]} onPick={() => {}} />,
    'a few matches': <EmojiPanel id="p" maxHeight={900} recent={[ROCKET]} onPick={() => {}} initialQuery="rocket" />,
    'no match': <EmojiPanel id="p" maxHeight={900} recent={[ROCKET]} onPick={() => {}} initialQuery="zzzzqqq" />,
  };
  for (const [name, view] of Object.entries(views)) assert.deepEqual(frame(renderToStaticMarkup(view)), { panel, field, list }, name);

  const few = renderToStaticMarkup(views['a few matches']);
  assert.ok((few.match(/<button/g) ?? []).length >= 1 && (few.match(/<button/g) ?? []).length < 10);
  assert.ok(!few.includes('Recently used'), 'a search shows its matches only');
  // No match: the list area is still there, with a line that says so in it.
  const none = renderToStaticMarkup(views['no match']);
  assert.equal((none.match(/<button/g) ?? []).length, 0);
  assert.match(none.slice(none.indexOf('overflow-y-auto')), /No emoji found for “zzzzqqq”\./);
  // In less room the panel is smaller, and again one size for every view.
  assert.match(frame(renderToStaticMarkup(<EmojiPanel maxHeight={220} recent={[]} onPick={() => {}} initialQuery="zzzzqqq" />)).panel, /style="height:220px"/);
  assert.match(frame(renderToStaticMarkup(<EmojiPanel maxHeight={220} recent={[ROCKET]} onPick={() => {}} />)).panel, /style="height:220px"/);
});

test('the panel without recent emojis starts with the first group', () => {
  const out = renderToStaticMarkup(<EmojiPanel recent={[]} onPick={() => {}} />);
  assert.ok(!out.includes('Recently used'));
  assert.equal((out.match(/<button/g) ?? []).length, ALL_EMOJIS.length);
});

test('the button says what it is and whether the panel is open', () => {
  const picker = (open: boolean) => renderToStaticMarkup(
    <EmojiPicker open={open} onOpenChange={() => {}} onInsert={() => {}} boxRef={{ current: null }} buttonClassName="b" />,
  );
  const closed = picker(false);
  assert.match(closed, /<button[^>]*type="button"[^>]*aria-label="Emoji"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  assert.ok(!closed.includes('role="dialog"'), 'closed: no panel in the page');
  const open = picker(true);
  assert.match(open, /aria-expanded="true"/);
  const controls = /aria-controls="([^"]+)"/.exec(open)?.[1];
  assert.ok(controls && open.includes(`id="${controls}" role="dialog"`), 'the button points at the panel it opened');
});
