// Quote a selection, as far as it can be checked without a browser: how a quote is written, that
// quoted text is shown as the text it was and never as markup, where the quote goes in the
// message box, and which selections can be quoted at all. Selecting with a mouse, a finger or
// the keyboard needs a real browser and is checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from '../app/markdown';
import {
  MAX_QUOTES, MESSAGE_TEXT_ATTRIBUTE, QuoteChips, QuoteMessageButton, QuoteSelectionButton, addQuote, composeMessage, escapeMarkdown,
  parseQuotes, pickSelection, placeButton, quoteExcerpt, quoteMarkdown, quoteMessage, quoteSelection, textBytes, tooLong, typedIntent,
  type Quote, type SelectionLike,
} from '../app/quote';
import { MAX_TEXT_BYTES, SENDERS } from '../lib/shared';
import { parseMessageInput } from '../lib/core';

const html = (text: string) => renderToStaticMarkup(<MessageBody text={text} />);
/** What a reader sees of rendered HTML: the text, with tags gone and entities decoded. */
const visible = (markup: string) => markup
  .replace(/<br\s*\/?>\n?/g, '\n').replace(/<\/p>\s*<p>/g, '\n\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const squash = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

test('a quote says who wrote it and in which message, then the text, each line marked', () => {
  assert.equal(quoteSelection('Grok', 45, 'the second point'), '> **Grok** in #45:\n>\n> the second point');
  // Lines of the selection stay lines (two spaces at the end are a line break); an empty line stays a break between paragraphs.
  assert.equal(quoteSelection('Claude', 7, 'first\nsecond\n\nnew paragraph'), '> **Claude** in #7:\n>\n> first  \n> second\n>\n> new paragraph');
  // White space around the selection, and a pile of empty lines inside it, are tidied.
  assert.equal(quoteSelection('Grok', 1, '\n\n  one \n\n\n\n two\n\n'), '> **Grok** in #1:\n>\n> one\n>\n> two');
  assert.equal(quoteSelection('Grok', 1, 'a\r\nb'), '> **Grok** in #1:\n>\n> a  \n> b', 'Windows line ends');
});

test('quoted text is shown as the text it was, never as markup', () => {
  const nasty = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '**not bold** and *not italic* and _not this_ either',
    '[a link](javascript:alert(1))',
    '![an image](not-an-address.png)',
    '# not a heading',
    '- not a list item',
    '+ nor this',
    '1. not a numbered item',
    '2) nor this',
    '`not code` and ```not a block```',
    'snake_case_name stays as it is',
    '~~not struck~~',
    '| not | a | table |',
    '&amp; stays five characters, &lt; too',
    'a \\ backslash and a \\* pair',
    '=== not an underline',
    '> not a nested quote',
    '[^1] not a footnote, [x] not a checkbox',
  ];
  for (const text of nasty) {
    const out = html(quoteSelection('Grok', 45, text));
    assert.ok(out.startsWith('<blockquote>'), `${text}: it is a quote`);
    // The only markup is the quote itself, its paragraphs and the bold name.
    const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    assert.deepEqual([...tags].sort(), ['blockquote', 'p', 'strong'], `${text}: ${out}`);
    assert.equal(squash(visible(out)), `Grok in #45:\n\n${text}`, `${text}: reads exactly as it was`);
  }
  // All of them at once, as lines of one selection.
  const all = html(quoteSelection('Grok', 45, nasty.join('\n')));
  assert.equal(squash(visible(all)), `Grok in #45:\n\n${nasty.join('\n')}`);
  assert.ok(!/<(script|img|a|em|code|h1|ul|ol|li|del|table)\b/.test(all), all);
});

test('a web address in a quote is a link as in any message, with the same rules, and nothing more', () => {
  for (const text of ['see https://example.com/page?x=1 for it', '![an image](https://tracker.example/pixel.png)', 'www.example.com', 'write to someone@example.com']) {
    const out = html(quoteSelection('Grok', 45, text));
    assert.equal(squash(visible(out)), `Grok in #45:\n\n${text}`, 'the text is unchanged');
    const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    assert.deepEqual([...tags].sort(), ['a', 'blockquote', 'p', 'strong'], out);
    assert.ok(!out.includes('<img'), 'an image address is never loaded');
    // Every link opens in a new tab without passing on where the reader came from, and its text is its own address.
    for (const link of out.match(/<a [^>]*>[^<]*<\/a>/g) ?? []) {
      assert.match(link, /target="_blank" rel="noopener noreferrer nofollow"/);
      const [, href, label] = /href="([^"]*)"[^>]*>([^<]*)</.exec(link) ?? [];
      assert.ok(href.replace(/^(https?:\/\/|mailto:)/, '').replace(/&amp;/g, '&') === label.replace(/^https?:\/\//, '').replace(/&amp;/g, '&'), `${href} shows as ${label}`);
    }
  }
  // An address with several query parameters reaches the link exactly as it was (found in review:
  // the "&" used to be escaped, which put a backslash into the link and into the text).
  const address = 'https://example.com/page?x=1&y=2&z=a_b';
  const two = html(quoteSelection('Grok', 45, `see ${address} for it`));
  assert.equal(/href="([^"]*)"/.exec(two)?.[1].replace(/&amp;/g, '&'), address, 'the link goes to the original address');
  assert.equal(/<a [^>]*>([^<]*)<\/a>/.exec(two)?.[1].replace(/&amp;/g, '&'), address, 'and shows it, with no backslash');
  assert.ok(!two.includes('\\') && !two.includes('%5C'), two);
  assert.equal(squash(visible(two)), `Grok in #45:\n\nsee ${address} for it`);
  // The same holds for the other characters an address may hold that mean something in Markdown.
  for (const tricky of ['https://example.com/_next/static/a_b.js', 'https://example.com/~user/*.txt?q=[1]', 'http://localhost.example:3000/a?b=c&d=e#f', 'www.example.com/a_b?x=1&y=2']) {
    const out = html(quoteSelection('Grok', 45, tricky));
    assert.equal(squash(visible(out)), `Grok in #45:\n\n${tricky}`, tricky);
    assert.ok(!out.includes('%5C'), `${tricky}: no backslash in the link: ${out}`);
    assert.ok(!/<(em|strong|del|code)\b/.test(out.replace('<strong>Grok</strong>', '')), `${tricky}: no formatting from characters of the address`);
  }
  // Punctuation after an address is not part of it, and stays text.
  const sentence = html(quoteSelection('Grok', 45, 'Is it https://example.com/a?b=1&c=2? Or *this*: https://example.com/x.'));
  assert.equal(squash(visible(sentence)), 'Grok in #45:\n\nIs it https://example.com/a?b=1&c=2? Or *this*: https://example.com/x.');
  assert.deepEqual([...sentence.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')), ['https://example.com/a?b=1&c=2', 'https://example.com/x']);
  assert.ok(!sentence.includes('<em>'));
  // Two more from the review. Closing punctuation directly behind an address used to be escaped with a
  // backslash, which the renderer took for one more character of the address.
  const starred = html(quoteSelection('Grok', 45, 'https://ex.com/*bold*'));
  assert.equal(/href="([^"]*)"/.exec(starred)?.[1], 'https://ex.com/*bold', 'no backslash in the link');
  assert.equal(squash(visible(starred)), 'Grok in #45:\n\nhttps://ex.com/*bold*', 'and the text is as it was');
  assert.ok(!starred.includes('%5C') && !starred.includes('\\') && !starred.includes('<em>'), starred);
  // An address written in angle brackets: the ">" is not part of the address.
  const angled = html(quoteSelection('Grok', 45, '<https://example.com>'));
  assert.equal(/href="([^"]*)"/.exec(angled)?.[1], 'https://example.com');
  assert.equal(/<a [^>]*>([^<]*)<\/a>/.exec(angled)?.[1], 'https://example.com');
  assert.equal(squash(visible(angled)), 'Grok in #45:\n\n<https://example.com>');
  // The same family, each checked for the link and for the text.
  for (const [text, href] of [
    ['see <https://example.com/a?b=1&c=2> now', 'https://example.com/a?b=1&c=2'],
    ['<https://example.com>, <https://example.org>.', 'https://example.com'],
    ['https://ex.com/a_b_ and _x_', 'https://ex.com/a_b'],
    ['https://ex.com/**', 'https://ex.com/'],
    ['https://ex.com/a]', 'https://ex.com/a'],
    ['https://ex.com/x*. Next', 'https://ex.com/x'],
    ['https://ex.com/a~b~', 'https://ex.com/a~b'],
    ['https://ex.com/x>y', 'https://ex.com/x%3Ey'],
  ]) {
    const out = html(quoteSelection('Grok', 45, text));
    assert.equal(/href="([^"]*)"/.exec(out)?.[1].replace(/&amp;/g, '&'), href, text);
    assert.equal(squash(visible(out)), `Grok in #45:\n\n${text}`, text);
    assert.ok(!out.includes('%5C') && !/<(em|del|code)\b/.test(out), `${text}: ${out}`);
  }
  // Something that only starts like an address is escaped like any text: no link with a label of the writer's choosing.
  const dressed = html(quoteSelection('Grok', 45, 'https://[click here](https://other.example/x) and http://*bold*'));
  assert.equal(squash(visible(dressed)), 'Grok in #45:\n\nhttps://[click here](https://other.example/x) and http://*bold*');
  assert.ok(!dressed.includes('<em>') && !/>click here</.test(dressed), dressed);
  // An address that would run something is not a link at all.
  const js = html(quoteSelection('Grok', 45, 'javascript:alert(1) and data:text/html,<b>x</b>'));
  assert.ok(!js.includes('<a ') && !js.includes('<b>'), js);
});

test('escapeMarkdown leaves ordinary writing alone', () => {
  for (const plain of ['Plain words, with commas. And a full stop!', 'snake_case and file_name.ts', 'It costs 3.50 (about) - roughly', 'Version 2.0 is out: see #45?', 'ünïcödé and 🚀 emoji']) {
    assert.equal(escapeMarkdown(plain), plain);
  }
  assert.equal(escapeMarkdown('a*b'), 'a\\*b');
  assert.equal(escapeMarkdown('_edge_'), '\\_edge\\_');
  assert.equal(escapeMarkdown('  indented'), 'indented', 'leading spaces would make a code block inside a quote');
  assert.equal(escapeMarkdown('@claude said so, at 12:30, see https://example.com'), '@claude said so, at 12:30, see https://example.com');
  // An ampersand is escaped only where it would start a character reference.
  assert.equal(escapeMarkdown('R&D, AT&T, a & b, x&y;z'), 'R&D, AT&T, a & b, x\\&y;z');
  assert.equal(escapeMarkdown('&lt; &amp; &#60; &#x3C; &nbsp;'), '\\&lt; \\&amp; \\&#60; \\&#x3C; \\&nbsp;');
  assert.equal(escapeMarkdown('&; &#; &#x; & amp;'), '&; &#; &#x; & amp;', 'not references: left alone');
});

test('quoting a whole message keeps its own Markdown, so it looks like the message', () => {
  const source = 'Two points:\n\n- **first**\n- second\n\n```js\nconst a = 1;\n```';
  const quote = quoteMessage('Claude', 12, source);
  assert.equal(quote, '> **Claude** in #12:\n>\n> Two points:\n>\n> - **first**\n> - second\n>\n> ```js\n> const a = 1;\n> ```');
  const out = html(quote);
  assert.match(out, /^<blockquote>/);
  assert.match(out, /<li><strong>first<\/strong><\/li>/);
  assert.match(out, /<pre><code class="language-js">const a = 1;\n<\/code><\/pre>/);
  // The same guard rails as for any message: no raw HTML, no image loaded.
  const hostile = html(quoteMessage('Grok', 3, '<script>alert(1)</script> ![x](https://tracker.example/p.png)'));
  assert.ok(!hostile.includes('<script') && !hostile.includes('<img'), hostile);
  assert.equal(quoteMessage('Grok', 3, '\n\nonly this   \n\n'), '> **Grok** in #3:\n>\n> only this');
});

/** A stand-in for a DOM element: it knows which message text it belongs to. */
const inMessage = (id: number | null) => {
  const holder = id === null ? null : { getAttribute: (name: string) => (name === MESSAGE_TEXT_ATTRIBUTE ? String(id) : null) };
  return { element: { closest: (selector: string) => (selector === `[${MESSAGE_TEXT_ATTRIBUTE}]` ? holder : null) }, holder };
};
const selection = (anchorNode: unknown, focusNode: unknown, text: string, collapsed = false): SelectionLike =>
  ({ isCollapsed: collapsed, rangeCount: 1, anchorNode, focusNode, toString: () => text });

test('only a selection inside the text of one message can be quoted', () => {
  const m45 = inMessage(45);
  // Both ends in the same message: yes. A text node reaches its message through its parent element.
  assert.deepEqual(pickSelection(selection(m45.element, m45.element, '  the point  ')), { messageId: 45, text: 'the point' });
  const textNode = { parentElement: m45.element };
  assert.deepEqual(pickSelection(selection(textNode, textNode, 'word')), { messageId: 45, text: 'word' });
  // Two ends in the same message text, reached through different elements inside it.
  const other = { closest: () => m45.holder };
  assert.deepEqual(pickSelection(selection(m45.element, other, 'across a paragraph')), { messageId: 45, text: 'across a paragraph' });

  // From one message into another: nothing.
  const second = { closest: () => inMessage(46).holder };
  assert.equal(pickSelection(selection(m45.element, second, 'spans two')), null);
  // One end outside message text (a name, a time, the page): nothing.
  const outside = inMessage(null);
  assert.equal(pickSelection(selection(m45.element, outside.element, 'half outside')), null);
  assert.equal(pickSelection(selection(outside.element, outside.element, 'the header')), null);
  // Nothing selected, only spaces, or no selection at all: nothing.
  assert.equal(pickSelection(selection(m45.element, m45.element, 'x', true)), null);
  assert.equal(pickSelection(selection(m45.element, m45.element, '  \n ')), null);
  assert.equal(pickSelection({ ...selection(m45.element, m45.element, 'x'), rangeCount: 0 }), null);
  assert.equal(pickSelection(null), null);
  assert.equal(pickSelection(selection(null, null, 'x')), null);
  // A marker that is not a message id: nothing.
  const broken = { closest: () => ({ getAttribute: () => 'abc' }) };
  assert.equal(pickSelection(selection(broken, broken, 'x')), null);
});

test('the Quote button stays on screen: below the selection, or above when there is no room', () => {
  const viewport = { width: 1000, height: 800 };
  assert.deepEqual(placeButton({ top: 100 }, { bottom: 120, right: 500 }, viewport), { top: 126, left: 424 });
  // At the bottom of the window: above the first line of the selection.
  assert.deepEqual(placeButton({ top: 700 }, { bottom: 790, right: 500 }, viewport), { top: 664, left: 424 });
  // At the edges: kept inside.
  assert.equal(placeButton({ top: 100 }, { bottom: 120, right: 20 }, viewport).left, 8);
  assert.equal(placeButton({ top: 100 }, { bottom: 120, right: 999 }, viewport).left, 1000 - 76 - 8);
  const phone = placeButton({ top: 300 }, { bottom: 320, right: 370 }, { width: 375, height: 812 });
  assert.ok(phone.left >= 8 && phone.left + 76 <= 375 - 8 && phone.top > 320);
});

test('both Quote buttons are real, labelled buttons', () => {
  const floating = renderToStaticMarkup(<QuoteSelectionButton at={{ top: 126, left: 424 }} onQuote={() => {}} />);
  assert.match(floating, /^<button type="button"[^>]*aria-label="Quote the selected text in your message"/);
  assert.match(floating, /style="top:126px;left:424px"/);
  assert.match(floating, />Quote<\/button>$/);
  const action = renderToStaticMarkup(<QuoteMessageButton messageId={45} onQuote={() => {}} className="c" />);
  assert.match(action, /^<button type="button" aria-label="Quote message #45"/);
  assert.match(action, />Quote<\/button>$/);
});

// --- quotes as chips ------------------------------------------------------------------------

const selected: Quote = { author: 'Grok', messageId: 45, kind: 'selection', text: 'the *second* point' };
const whole: Quote = { author: 'Claude', messageId: 46, kind: 'message', text: 'Two points:\n\n- **first**\n- second' };

test('on send, the chips become the same Markdown as a quote always was, in order, before the typed text', () => {
  assert.equal(quoteMarkdown(selected), quoteSelection('Grok', 45, 'the *second* point'));
  assert.equal(quoteMarkdown(whole), quoteMessage('Claude', 46, whole.text));
  const sent = composeMessage([selected, whole], 'I agree with both.');
  assert.equal(sent, [
    '> **Grok** in #45:', '>', '> the \\*second\\* point', '',
    '> **Claude** in #46:', '>', '> Two points:', '>', '> - **first**', '> - second', '',
    'I agree with both.',
  ].join('\n'));
  // It renders as two quotes followed by the answer; the selection shows its stars as stars.
  const out = html(sent);
  assert.equal(out.match(/<blockquote>/g)?.length, 2);
  assert.match(out, /<p>the \*second\* point<\/p>/);
  assert.match(out, /<li><strong>first<\/strong><\/li>/);
  assert.match(out, /<\/blockquote>\s*<p>I agree with both\.<\/p>$/);
});

test('a message without quotes is exactly what was typed; one with quotes only is just the quotes', () => {
  for (const typed of ['plain', '  leading spaces and a trailing line\n', '', '@grok DECISION: yes']) assert.equal(composeMessage([], typed), typed);
  assert.equal(composeMessage([selected], ''), quoteMarkdown(selected));
  assert.equal(composeMessage([selected], '   \n'), quoteMarkdown(selected), 'spaces alone add nothing');
  assert.equal(composeMessage([selected, selected], ''), `${quoteMarkdown(selected)}\n\n${quoteMarkdown(selected)}`);
  // The server takes a quotes-only message: its text is not empty.
  assert.equal(parseMessageInput({ text: composeMessage([selected], '') }).ok, true);
});

test('at most five quotes, each one once, in the order they were added', () => {
  let list: Quote[] = [];
  for (let n = 1; n <= MAX_QUOTES; n++) {
    const result = addQuote(list, { ...selected, messageId: n });
    assert.equal(result.refused, null);
    list = result.quotes;
  }
  assert.deepEqual(list.map((q) => q.messageId), [1, 2, 3, 4, 5]);
  const sixth = addQuote(list, { ...selected, messageId: 6 });
  assert.equal(sixth.refused, 'full');
  assert.equal(sixth.quotes, list, 'the list is left as it was');
  // The same words from the same message again add nothing; other words from it do.
  assert.equal(addQuote([selected], { ...selected }).refused, 'duplicate');
  assert.equal(addQuote([selected], { ...selected }).quotes.length, 1);
  assert.equal(addQuote([selected], { ...selected, text: 'another part' }).quotes.length, 2);
  assert.equal(addQuote([selected], { ...selected, kind: 'message' }).quotes.length, 2, 'the whole message is not the same as a part of it');
  assert.equal(addQuote([selected], whole, 1).refused, 'full', 'the cap can be set');
});

test('the 20 KB limit counts the composed text, and the writer is told before sending', () => {
  assert.equal(textBytes('abc'), 3);
  assert.equal(textBytes('äöü'), 6, 'bytes, not characters');
  assert.equal(textBytes('🚀'), 4);
  assert.equal(tooLong('short', 0), null);
  assert.equal(tooLong('x'.repeat(MAX_TEXT_BYTES), 0), null, 'exactly at the limit still fits');
  assert.equal(tooLong('x'.repeat(MAX_TEXT_BYTES + 1), 0), 'This message is 20.1 KB. The limit is 20 KB.', 'one byte over is not shown as exactly the limit');
  // Typed text that fits by itself, pushed over by its quotes.
  const typed = 'y'.repeat(12 * 1024);
  const big: Quote = { ...selected, text: 'z'.repeat(10 * 1024) };
  assert.equal(tooLong(typed, 0), null);
  const composed = composeMessage([big], typed);
  const said = String(tooLong(composed, 1));
  assert.match(said, /^With its quote this message is 22\.\d KB\. The limit is 20 KB: remove a quote or shorten the text\.$/);
  assert.match(String(tooLong(composeMessage([big, big], ''), 2)), /^With its quotes /);
  // The page's check and the server's agree: what the page lets through, the server takes, and the other way round.
  assert.equal(parseMessageInput({ text: composed }).ok, false);
  const fits = composeMessage([{ ...selected, text: 'z'.repeat(7 * 1024) }], typed);
  assert.equal(tooLong(fits, 1), null);
  assert.equal(parseMessageInput({ text: fits }).ok, true);
  // Escaping makes a quote longer than the selection was, and that is what counts.
  const stars = '*'.repeat(11 * 1024);
  assert.ok(textBytes(stars) < MAX_TEXT_BYTES && tooLong(composeMessage([{ ...selected, text: stars }], ''), 1) !== null);
});

test('"@name" and "DECISION:" at the start of the typed text are read as the server reads them', () => {
  assert.deepEqual(typedIntent('@grok please look', SENDERS), { to: 'grok', decision: false });
  assert.deepEqual(typedIntent('  @Claude: done?', SENDERS), { to: 'claude', decision: false });
  assert.deepEqual(typedIntent('DECISION: ship it', SENDERS), { to: null, decision: true });
  assert.deepEqual(typedIntent('@david, DECISION: ship it', SENDERS), { to: 'david', decision: true });
  assert.deepEqual(typedIntent('no @grok here, and no DECISION: either', SENDERS), { to: null, decision: false });
  assert.deepEqual(typedIntent('decision: lower case does not pin', SENDERS), { to: null, decision: false });
  assert.deepEqual(typedIntent('@nobody hello', SENDERS), { to: null, decision: false });
  assert.deepEqual(typedIntent('', SENDERS), { to: null, decision: false });
  // The same answers as the server gives for the same text standing alone.
  for (const typed of ['@grok please look', '  @Claude: done?', 'DECISION: ship it', '@david, DECISION: ship it', '@david DECISION: x', 'plain', 'x @grok', '@GROK hi', '@grokster hi']) {
    const server = parseMessageInput({ text: typed });
    assert.ok(server.ok);
    assert.deepEqual(typedIntent(typed, SENDERS), { to: server.recipient, decision: server.pinned }, typed);
  }
  // With a quote in front, the server no longer sees either. That is why the page asks for them itself.
  const withQuote = parseMessageInput({ text: composeMessage([selected], '@grok DECISION: ship it') });
  assert.ok(withQuote.ok && withQuote.recipient === null && withQuote.pinned === false);
  // Names with characters that mean something in a pattern can't break it.
  assert.deepEqual(typedIntent('@a.b hi', ['a.b', '(x']), { to: null, decision: false });
});

test('a quote can never decide who the message is for', () => {
  // Found in use: a message that began with a quoted line starting with "@david" was addressed
  // to David. The recipient is read from an "@name" at the very start of the message text.
  const mention: Quote = { author: 'Claude', messageId: 43, kind: 'selection', text: '@grok please review this\nand DECISION: ship it' };
  const wholeMention: Quote = { author: 'Claude', messageId: 43, kind: 'message', text: '@grok DECISION: ship it' };
  for (const quote of [mention, wholeMention]) {
    // A composed message starts with the quote's header line, so the server finds no "@name" at its start, and no "DECISION:".
    const quoted = composeMessage([quote], 'I agree.');
    assert.ok(quoted.startsWith('> **Claude** in #43:'), quoted);
    const server = parseMessageInput({ text: quoted });
    assert.ok(server.ok && server.recipient === null && server.pinned === false, 'the quote neither addresses nor pins');
    // Quotes only: the same.
    const only = parseMessageInput({ text: composeMessage([quote], '') });
    assert.ok(only.ok && only.recipient === null && only.pinned === false);
    // Every line of a quote starts with ">", so no line of it can look like the start of a message.
    assert.ok(quoteMarkdown(quote).split('\n').every((line) => line.startsWith('>')));
  }
  // The page reads the recipient from what the writer typed, and from nothing else.
  assert.deepEqual(typedIntent('I agree.', SENDERS), { to: null, decision: false });
  assert.deepEqual(typedIntent('@claude I agree.', SENDERS), { to: 'claude', decision: false });
  assert.deepEqual(typedIntent('', SENDERS), { to: null, decision: false }, 'quotes only: nobody in particular');
  // So: a quote that starts with "@grok", an answer that starts with "@claude". It goes to Claude.
  const body = { text: composeMessage([mention], '@claude I agree.'), to: typedIntent('@claude I agree.', SENDERS).to };
  const sent = parseMessageInput(body);
  assert.ok(sent.ok && sent.recipient === 'claude');
});

test('a chip shows who, which message and the first words; the full text is its tooltip', () => {
  assert.equal(quoteExcerpt('short'), 'short');
  assert.equal(quoteExcerpt('  several\n\nlines   and   spaces '), 'several lines and spaces');
  const cut = quoteExcerpt('word '.repeat(40));
  assert.ok(cut.length <= 60 && cut.endsWith('…'));
  // A whole message is kept as its Markdown source. Its chip leaves the escape backslashes out; a selection is shown as it is.
  assert.equal(quoteExcerpt('Literal \\*stars\\* and \\<b\\>', 60, 'message'), 'Literal *stars* and <b>');
  assert.equal(quoteExcerpt('a path C:\\temp', 60, 'selection'), 'a path C:\\temp');
  const long: Quote = { ...selected, text: 'The second point is the one that matters most here, because it decides the storage.' };
  const out = renderToStaticMarkup(<QuoteChips quotes={[{ ...long, key: 1 }, { ...whole, key: 2 }]} onRemove={() => {}} />);
  assert.equal((out.match(/<li[ >]/g) ?? []).length, 2);
  assert.match(out, /<span class="font-bold">Grok<\/span>, #45 <span class="text-muted">“The second point is the one that matters most here, becaus[^”]*…”<\/span>/);
  assert.ok(out.includes(`title="${long.text}"`), 'the full text as a tooltip');
  assert.ok(out.includes('aria-label="Remove the quote from Grok, #45"') && out.includes('aria-label="Remove the quote from Claude, #46"'));
  assert.equal(renderToStaticMarkup(<QuoteChips quotes={[]} onRemove={() => {}} />), '');
  // A chip shows text as text, whatever was quoted.
  const hostile = renderToStaticMarkup(<QuoteChips quotes={[{ ...selected, key: 3, text: '<img src=x onerror=alert(1)> **b**' }]} onRemove={() => {}} />);
  assert.ok(!/<img|<strong|<script/.test(hostile), hostile);
});

test('quotes read back from storage are checked one by one', () => {
  assert.deepEqual(parseQuotes([selected, whole]), [selected, whole]);
  assert.deepEqual(parseQuotes('not a list'), []);
  assert.deepEqual(parseQuotes(null), []);
  assert.deepEqual(parseQuotes([{ ...selected, extra: 'dropped', key: 9 }]), [selected], 'only the four known fields are taken');
  assert.deepEqual(parseQuotes([{ ...selected, author: 'x'.repeat(81) }, { ...selected, messageId: 1.5 }, { ...selected, messageId: '45' }, { ...selected, text: 7 }, undefined, 3]), []);
  assert.equal(parseQuotes(Array.from({ length: 12 }, (_, n) => ({ ...selected, messageId: n + 1 }))).length, MAX_QUOTES);
});
