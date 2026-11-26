// A comment on a quote, as far as it can be checked without a browser: what is sent and in which
// order, who the message is for and whether it is pinned, the kept draft, and the markup of the
// box and the chip. Opening the box at a selection, the focus and the keys need a real browser and
// are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chip } from '../app/chips';
import { draftKey, readDraft, writeDraft } from '../app/composer';
import { isDecision } from '../app/decision';
import {
  MAX_COMMENT_CHARS, QuoteChips, QuoteCommentBox, chipTooltip, commentKey, composeMessage, composedIntent, parseQuotes, placeCommentBox,
  quoteBlock, sameQuote, tidyComment, tooLong, withComment, type Quote, type QuoteChip,
} from '../app/quote';
import { parseMessageInput } from '../lib/core';
import { MAX_TEXT_BYTES } from '../lib/shared';

/** The participants that apply when the PARTICIPANTS setting is not set. */
const NAMES = ['grok', 'claude', 'david'];
const first: Quote = { author: 'Grok', messageId: 45, kind: 'selection', text: 'Which storage do we use?' };
const second: Quote = { author: 'Grok', messageId: 45, kind: 'selection', text: 'I see two options.' };
const third: Quote = { author: 'Claude', messageId: 46, kind: 'message', text: 'Both would *work*.' };

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test('each quote is followed by its comment, in the order the quotes were added; the message box comes last', () => {
  const quotes = [withComment(first, 'The database.'), second, withComment(third, 'Agreed, **with** one condition:\n\n- keep it small')];
  assert.equal(composeMessage(quotes, 'That is all from me.'), [
    '> **Grok** in #45:',
    '>',
    '> Which storage do we use?',
    '',
    'The database.',
    '',
    '> **Grok** in #45:',
    '>',
    '> I see two options.',
    '',
    '> **Claude** in #46:',
    '>',
    '> Both would *work*.',
    '',
    'Agreed, **with** one condition:',
    '',
    '- keep it small',
    '',
    'That is all from me.',
  ].join('\n'));
  // The other order of adding: the other order of sending.
  const reversed = composeMessage([...quotes].reverse(), '');
  assert.ok(reversed.indexOf('#46') < reversed.indexOf('The database.'));
  // A message may be quotes and comments only.
  assert.equal(composeMessage([withComment(first, 'The database.')], '   '), '> **Grok** in #45:\n>\n> Which storage do we use?\n\nThe database.');
  // Without comments and without quotes nothing changed.
  assert.equal(composeMessage([first], 'ok'), '> **Grok** in #45:\n>\n> Which storage do we use?\n\nok');
  assert.equal(composeMessage([], '  as typed  '), '  as typed  ');
  assert.equal(quoteBlock(first), '> **Grok** in #45:\n>\n> Which storage do we use?');
});

test('the quoted part is escaped as before; the comment is the writer\'s own Markdown', () => {
  const quote = withComment({ author: 'Grok', messageId: 7, kind: 'selection' as const, text: 'use *stars* and <b>' }, 'I *mean* it, see `code` and <b>');
  const block = quoteBlock(quote);
  assert.ok(block.includes('> use \\*stars\\* and \\<b\\>'), block);
  assert.ok(block.endsWith('\n\nI *mean* it, see `code` and <b>'), block);
});

test('a comment is kept tidy, and an empty one is no comment', () => {
  assert.equal(tidyComment('  indented stays  \n\n'), '  indented stays');
  assert.equal(tidyComment('\n\n \nline one\r\nline two\n'), 'line one\nline two');
  for (const empty of [undefined, '', '   ', '\n\n', ' \n\t\n']) assert.equal(tidyComment(empty), '', JSON.stringify(empty));
  assert.deepEqual(withComment(first, '  '), first);
  assert.ok(!('comment' in withComment(withComment(first, 'x'), '')), 'taking the comment away leaves a plain quote');
  assert.deepEqual(withComment(first, ' yes \n'), { ...first, comment: ' yes' });
  // The comment plays no part in telling two quotes apart.
  assert.equal(sameQuote(first, withComment(first, 'a comment')), true);
  assert.equal(sameQuote(first, second), false);
});

test('the 20 KB check covers the comments', () => {
  const big = 'x'.repeat(MAX_COMMENT_CHARS);
  const five = [1, 2, 3, 4, 5].map((n) => withComment({ ...first, text: `part ${n}` }, big));
  assert.equal(tooLong(composeMessage(five, ''), five.length), null, 'five full comments fit');
  const composed = composeMessage(five, 'y'.repeat(MAX_TEXT_BYTES));
  assert.match(tooLong(composed, five.length) ?? '', /With its quotes this message is \d+\.\d KB\. The limit is 20 KB/);
});

test('a quote or a comment never decides who the message is for', () => {
  const to = (quotes: Quote[], typed: string) => composedIntent(quotes, typed, NAMES).to;
  // Only "@name" at the start of the message box counts.
  assert.equal(to([first], '@claude what do you think?'), 'claude');
  assert.equal(to([withComment(first, '@grok this is for you')], ''), null);
  assert.equal(to([withComment(first, '@grok this is for you')], 'and a last word'), null);
  assert.equal(to([withComment(first, '@grok this is for you')], '@david please decide'), 'david');
  assert.equal(to([{ ...first, text: '@david quoted words' }], ''), null);
  // And the server, which reads the start of the text, finds a quote there: nobody is addressed, nothing is pinned.
  for (const comment of ['@grok this is for you', '@grok DECISION: go', 'DECISION: go']) {
    const sent = parseMessageInput({ text: composeMessage([withComment(first, comment)], '') }, NAMES);
    assert.ok(sent.ok);
    assert.equal(sent.recipient, null, comment);
    assert.equal(sent.pinned, false, comment);
  }
});

test('a message with quotes is a decision when the first thing its writer says starts with DECISION:', () => {
  const decision = (quotes: Quote[], typed: string) => composedIntent(quotes, typed, NAMES).decision;
  // As before: nothing said about the quotes, and the message box starts with DECISION:.
  assert.equal(decision([first, second], 'DECISION: the database'), true);
  assert.equal(decision([first], '@grok DECISION: the database'), true);
  assert.equal(decision([first], 'I think DECISION: is too strong'), false);
  // The comment under the first quote is the first thing said: it decides.
  assert.equal(decision([withComment(first, 'DECISION: the database')], ''), true);
  assert.equal(decision([withComment(first, 'DECISION: the database'), second], 'and more below'), true);
  assert.equal(decision([first, withComment(second, 'DECISION: the database')], ''), true, 'the first quote has no comment, so this one speaks first');
  // Something else was said first: a DECISION: further down is text.
  assert.equal(decision([withComment(first, 'Good question.'), withComment(second, 'DECISION: the database')], ''), false);
  assert.equal(decision([withComment(first, 'Good question.')], 'DECISION: the database'), false);
  // Quoting a decision is not deciding.
  assert.equal(decision([{ ...first, text: 'DECISION: the database' }], 'I am not sure.'), false);
  assert.equal(decision([{ ...first, text: 'DECISION: the database' }], ''), false);
  // The pin the page asks for and the badge the page shows are the same rule, on the same text.
  const cases: [Quote[], string][] = [
    [[withComment(first, 'DECISION: a')], ''], [[withComment(first, 'no'), withComment(second, 'DECISION: b')], ''], [[first], 'DECISION: c'],
    [[withComment(first, '@claude DECISION: d')], 'x'], [[first, second, third], ''], [[withComment(third, '> a quote inside the comment\n\nDECISION: e')], ''],
  ];
  for (const [quotes, typed] of cases) assert.equal(decision(quotes, typed), isDecision(composeMessage(quotes, typed), NAMES), composeMessage(quotes, typed));
  // "@name DECISION:" in a comment pins, and still addresses nobody.
  assert.deepEqual(composedIntent([withComment(first, '@claude DECISION: d')], '', NAMES), { to: null, decision: true });
});

test('comments are kept with their chips across a reload', () => {
  const storage = memoryStorage();
  const quotes = [withComment(first, 'The database.\n\nSecond paragraph.'), second, withComment(third, 'Agreed.')];
  writeDraft(storage, 'david', { text: 'main text', quotes });
  assert.deepEqual(readDraft(storage, 'david'), { text: 'main text', quotes });
  // What is stored holds the comment next to its quote, and no key or anything else.
  const stored = JSON.parse(storage.getItem(draftKey('david')) ?? '') as { quotes: Record<string, unknown>[] };
  assert.deepEqual(stored.quotes.map((q) => Object.keys(q).sort()), [
    ['author', 'comment', 'kind', 'messageId', 'text'], ['author', 'kind', 'messageId', 'text'], ['author', 'comment', 'kind', 'messageId', 'text'],
  ]);
  // Quotes with comments and nothing in the message box are worth keeping too.
  writeDraft(storage, 'david', { text: '', quotes: [withComment(first, 'only this')] });
  assert.deepEqual(readDraft(storage, 'david'), { text: '', quotes: [withComment(first, 'only this')] });
  // After sending there is nothing left.
  writeDraft(storage, 'david', { text: '', quotes: [] });
  assert.equal(storage.getItem(draftKey('david')), null);
  // A draft from before comments existed reads as before.
  const old = memoryStorage({ [draftKey('david')]: JSON.stringify({ v: 1, text: 't', quotes: [first] }) });
  assert.deepEqual(readDraft(old, 'david'), { text: 't', quotes: [first] });
});

test('a stored comment that is not text, or far too long, is dropped and the quote kept', () => {
  assert.deepEqual(parseQuotes([{ ...first, comment: 'fine' }]), [{ ...first, comment: 'fine' }]);
  assert.deepEqual(parseQuotes([{ ...first, comment: '  \n' }]), [first]);
  for (const bad of [7, null, ['x'], { text: 'x' }, 'x'.repeat(MAX_COMMENT_CHARS + 1)]) {
    assert.deepEqual(parseQuotes([{ ...first, comment: bad }]), [first], JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(parseQuotes([{ ...first, comment: 'x'.repeat(MAX_COMMENT_CHARS) }])[0].comment?.length, MAX_COMMENT_CHARS);
});

test('the comment box: the quoted words on top, one line for the comment, a button to add', () => {
  const long: Quote = { ...first, text: `${'Which storage do we use? '.repeat(8)}end` };
  const out = renderToStaticMarkup(<QuoteCommentBox quote={long} at={{ top: 200, left: 300 }} onSubmit={() => {}} onCancel={() => {}} />);
  assert.match(out, /^<div role="dialog" aria-label="Quote Grok, #45, with a comment" data-quote-comment="true" style="top:200px;left:300px" class="fixed /);
  // The quoted words, cut with an ellipsis.
  const shown = /<span class="font-bold text-fg">Grok<\/span>, #45 “([^”]*)”/.exec(out)?.[1] ?? '';
  assert.ok(shown.startsWith('Which storage do we use? Which storage do we use?') && shown.endsWith('…') && shown.length <= 70, shown);
  // One line, optional, named for screen readers.
  assert.match(out, /<textarea rows="1" maxLength="4000" placeholder="Add a comment \(optional\)" aria-label="Your comment on this quote"[^>]*><\/textarea>/);
  const buttons = [...out.matchAll(/<button type="button"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['Add']);
  assert.match(out, /Enter adds the quote · Shift\+Enter for a new line · Esc cancels/);
  // The quoted words are text here too: nothing from a message becomes markup.
  const nasty = renderToStaticMarkup(<QuoteCommentBox quote={{ ...first, text: '<img src=x onerror=alert(1)> **bold**' }} at={{ top: 1, left: 1 }} onSubmit={() => {}} onCancel={() => {}} />);
  assert.ok(!nasty.includes('<img') && nasty.includes('&lt;img src=x'), nasty);
});

test('changing the comment of a chip: the same box, in the page, with the comment in it', () => {
  const out = renderToStaticMarkup(<QuoteCommentBox quote={withComment(first, 'The database.')} editing onSubmit={() => {}} onCancel={() => {}} />);
  assert.match(out, /^<div role="dialog" aria-label="Your comment on the quote from Grok, #45" data-quote-comment="true" class="mb-2 /);
  assert.ok(!out.includes('fixed'), 'it stands above the message box, it does not float');
  assert.match(out, /<textarea[^>]*>The database\.<\/textarea>/);
  assert.match(out, /<button type="button"[^>]*>Save<\/button>/);
});

test('the keys of the comment line', () => {
  assert.equal(commentKey('Enter', false, false), 'submit');
  assert.equal(commentKey('Enter', true, false), null, 'Shift+Enter is a new line');
  assert.equal(commentKey('Enter', false, true), null, 'Enter that finishes a composed character is not a submit');
  assert.equal(commentKey('Escape', false, false), 'cancel');
  assert.equal(commentKey('a', false, false), null);
});

test('the box opens where the quote was picked, and stays inside the window', () => {
  const window = { width: 1280, height: 800 };
  assert.deepEqual(placeCommentBox({ top: 300, left: 400 }, window), { top: 300, left: 400, width: 352 });
  // Too far right, too far down, or off to the left: moved in.
  assert.deepEqual(placeCommentBox({ top: 790, left: 1200 }, window), { top: 660, left: 920, width: 352 });
  assert.deepEqual(placeCommentBox({ top: -20, left: -100 }, window), { top: 8, left: 8, width: 352 });
  // A phone: the box takes the width there is.
  assert.deepEqual(placeCommentBox({ top: 400, left: 200 }, { width: 375, height: 700 }), { top: 400, left: 15, width: 352 });
  assert.deepEqual(placeCommentBox({ top: 400, left: 200 }, { width: 320, height: 500 }), { top: 360, left: 8, width: 304 });
});

test('a chip says when it carries a comment, and opens it', () => {
  const chips: QuoteChip[] = [{ ...withComment(first, 'The database, **I think**.'), key: 1 }, { ...second, key: 2 }];
  const out = renderToStaticMarkup(<ul><QuoteChips quotes={chips} onRemove={() => {}} onEdit={() => {}} /></ul>);
  const items = [...out.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(items.length, 2);
  // Each chip: one button that opens the comment, and next to it the button that removes the quote.
  for (const item of items) assert.equal((item.match(/<button type="button"/g) ?? []).length, 2);
  assert.match(items[0], /<button type="button" aria-label="Edit your comment on the quote from Grok, #45"/);
  assert.match(items[0], /<button type="button" aria-label="Remove the quote from Grok, #45"/);
  assert.match(items[1], /<button type="button" aria-label="Add a comment to the quote from Grok, #45"/);
  // Who, which message, the first words, and a quiet marker for the comment.
  assert.match(items[0], /<span class="font-bold">Grok<\/span>, #45 <span class="text-muted">“Which storage do we use\?”<\/span><span class="text-muted"> · with reply<\/span>/);
  assert.ok(!items[1].includes('with reply'));
  // The tooltip: the quoted words, and the start of the comment.
  assert.equal(chipTooltip(chips[0]), 'Which storage do we use?\n\nYour comment: The database, **I think**.');
  assert.equal(chipTooltip(chips[1]), 'I see two options.');
  assert.ok(items[0].includes('title="Which storage do we use?\n\nYour comment: The database, **I think**."'), items[0]);
  assert.ok(chipTooltip({ ...first, comment: 'c'.repeat(900) }).endsWith(`${'c'.repeat(400)}…`));
});

test('a chip that can be opened is a button; one that cannot is as it was', () => {
  const open = renderToStaticMarkup(<Chip visual="↳" title="more" onRemove={() => {}} removeLabel="Remove it" onOpen={() => {}} openLabel="Open it">words</Chip>);
  assert.match(open, /^<li[^>]*><button type="button" aria-label="Open it" title="more"[^>]*><span aria-hidden="true"[^>]*>↳<\/span><span class="[^"]*truncate">words<\/span><\/button><button type="button" aria-label="Remove it" title="Remove it"[^>]*>×<\/button><\/li>$/);
  const plain = renderToStaticMarkup(<Chip visual="↳" title="more" onRemove={() => {}} removeLabel="Remove it">words</Chip>);
  assert.match(plain, /^<li[^>]*><span aria-hidden="true"[^>]*>↳<\/span><span class="[^"]*truncate" title="more">words<\/span><button type="button" aria-label="Remove it"/);
  assert.equal((plain.match(/<button/g) ?? []).length, 1);
});
