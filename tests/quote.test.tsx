// Quote a selection, as far as it can be checked without a browser: how a quote is written, that
// quoted text is shown as the text it was and never as markup, where the quote goes in the
// message box, and which selections can be quoted at all. Selecting with a mouse, a finger or
// the keyboard needs a real browser and is checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from '../app/markdown';
import {
  MESSAGE_TEXT_ATTRIBUTE, QuoteMessageButton, QuoteSelectionButton, escapeMarkdown, insertQuote, pickSelection, placeButton,
  quoteMessage, quoteSelection, type SelectionLike,
} from '../app/quote';

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

test('the quote goes in at the cursor as a paragraph of its own, with the cursor after an empty line', () => {
  const q = '> **Grok** in #45:\n>\n> text';
  // An empty box.
  assert.deepEqual(insertQuote('', 0, 0, q), { text: `${q}\n\n`, cursor: q.length + 2 });
  // At the end of a line of text: an empty line before the quote.
  const atEnd = insertQuote('I agree with this:', 18, 18, q);
  assert.equal(atEnd.text, `I agree with this:\n\n${q}\n\n`);
  assert.equal(atEnd.cursor, atEnd.text.length);
  // In the middle: the cursor gets a line of its own, and the rest of the text follows as its own paragraph.
  const middle = insertQuote('before after', 7, 7, q);
  assert.equal(middle.text, `before\n\n${q}\n\n\n\nafter`);
  assert.equal(middle.text.slice(0, middle.cursor), `before\n\n${q}\n\n`);
  assert.equal(middle.text.slice(middle.cursor), '\n\nafter');
  // So what is typed next can't run into the text behind it, or into a quote that stands there.
  const typed = `${middle.text.slice(0, middle.cursor)}my answer${middle.text.slice(middle.cursor)}`;
  assert.equal(typed, `before\n\n${q}\n\nmy answer\n\nafter`);
  const inFront = insertQuote(`${q}\n\nearlier answer`, 0, 0, q);
  const answered = `${inFront.text.slice(0, inFront.cursor)}new answer${inFront.text.slice(inFront.cursor)}`;
  assert.equal(html(answered).match(/<blockquote>/g)?.length, 2, 'both quotes are still quotes');
  assert.match(html(answered), /<p>new answer<\/p>\s*<blockquote>/);
  // Over a selection: the selected text is replaced.
  assert.equal(insertQuote('keep REPLACE keep', 5, 12, q).text, `keep\n\n${q}\n\n\n\nkeep`);
  // Already on a fresh line, or after an empty line: no extra empty lines pile up.
  assert.equal(insertQuote('line\n', 5, 5, q).text, `line\n\n${q}\n\n`);
  assert.equal(insertQuote('line\n\n', 6, 6, q).text, `line\n\n${q}\n\n`);
  assert.equal(insertQuote('a\n\n\n\nb', 1, 1, q).text, `a\n\n${q}\n\n\n\nb`);
  // Two quotes in a row stay two quotes.
  const first = insertQuote('', 0, 0, q);
  const second = insertQuote(first.text, first.cursor, first.cursor, q);
  assert.equal(second.text, `${q}\n\n${q}\n\n`);
  assert.equal(html(second.text).match(/<blockquote>/g)?.length, 2);
  // Positions that make no sense never lose text.
  assert.equal(insertQuote('abc', 99, 99, q).text, `abc\n\n${q}\n\n`);
  assert.equal(insertQuote('abc', -1, -1, q).text, `${q}\n\n\n\nabc`);
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
