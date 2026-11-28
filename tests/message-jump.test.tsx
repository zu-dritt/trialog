// «#966» jumps to message 966, and «g 966 ↵» does the same from the keyboard (playground #970).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { HUB_WINDOW, messageHref, messageIdOfHash, splitMessageRefs } from '../app/links';
import { MessageBody } from '../app/markdown';
import { FlightText } from '../app/flight';
import { GO_TO_MAX_DIGITS, SHORTCUTS, goToStep } from '../app/shortcuts';

test('«#966» is a message reference; words, addresses, entities and colours are not', () => {
  assert.deepEqual(splitMessageRefs('after the Agree in #966.'), ['after the Agree in ', { id: 966, typed: '#966' }, '.']);
  assert.deepEqual(splitMessageRefs('#1 and (#23)'), [{ id: 1, typed: '#1' }, ' and (', { id: 23, typed: '#23' }, ')']);
  assert.deepEqual(splitMessageRefs('issue#12'), ['issue#12']);
  assert.deepEqual(splitMessageRefs('https://x.dev/a/#12'), ['https://x.dev/a/#12']);
  assert.deepEqual(splitMessageRefs('it&#39;s'), ['it&#39;s']);
  assert.deepEqual(splitMessageRefs('colour #4fb3ff'), ['colour #4fb3ff']);
  assert.deepEqual(splitMessageRefs('##5'), ['##5']);
  assert.deepEqual(splitMessageRefs('#0'), ['#0']);
});

test('the address of a message, and back', () => {
  assert.equal(messageHref(966), '/#m-966');
  assert.equal(messageIdOfHash('#m-966'), 966);
  assert.equal(messageIdOfHash('#m-'), null);
  assert.equal(messageIdOfHash('#top'), null);
  assert.equal(messageIdOfHash(''), null);
});

test('in a message, «#966» links to the message in the hub tab; PR #116 and code stay as they were', () => {
  const html = renderToStaticMarkup(<MessageBody text="Agree in #966, see PR #116 and `#12`." repo="example-org/trialog" />);
  assert.match(html, new RegExp(`<a href="/#m-966" target="${HUB_WINDOW}" data-message-ref="966" title="Go to message #966">#966</a>`));
  assert.match(html, /href="https:\/\/github\.com\/example-org\/trialog\/pull\/116"/);
  assert.ok(!html.includes('data-message-ref="116"'), html);
  assert.match(html, /<code>#12<\/code>/);
  assert.equal((html.match(/data-message-ref/g) ?? []).length, 1);
});

test('a message reference opens in the same tab, without a globe or a hovercard', () => {
  const html = renderToStaticMarkup(<MessageBody text="#5" repo={null} />);
  assert.ok(!html.includes('_blank'), html);
  assert.ok(!html.includes('hovercard'), html);
});

test('a card note or a wait: «#936» links to the message, addresses still link out', () => {
  const html = renderToStaticMarkup(<FlightText text="⛔ WAITING ON DAVID: Agree on #936, https://example.org/x" />);
  assert.match(html, /<a href="\/#m-936" target="trialog-hub" data-message-ref="936"/);
  assert.match(html, /href="https:\/\/example\.org\/x"/);
  const hidden = renderToStaticMarkup(<FlightText text="#936" hidden />);
  assert.match(hidden, /tabindex="-1"/);
});

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: null, ...extra });

test('g, then the number, then Enter goes to that message', () => {
  let s = goToStep(null, key('g'));
  assert.deepEqual(s, { digits: '', handled: true });
  for (const d of '966') s = goToStep(s.digits, key(d));
  assert.equal(s.digits, '966');
  s = goToStep(s.digits, key('Backspace'));
  assert.equal(s.digits, '96');
  s = goToStep(s.digits, key('6'));
  assert.deepEqual(goToStep(s.digits, key('Enter')), { digits: null, go: 966, handled: true });
});

test('g gives up on Esc, on Enter without a number, and on any other key, which then works as usual', () => {
  assert.deepEqual(goToStep('12', key('Escape')), { digits: null, handled: true });
  assert.deepEqual(goToStep('', key('Enter')), { digits: null, handled: true });
  assert.deepEqual(goToStep('12', key('j')), { digits: null, handled: false });
  assert.deepEqual(goToStep('12', key('Shift')), { digits: '12', handled: false });
});

test('g is not ours while typing or with a modifier, and the number has a limit', () => {
  assert.deepEqual(goToStep(null, key('g', { target: { tagName: 'TEXTAREA' } })), { digits: null, handled: false });
  assert.deepEqual(goToStep(null, key('g', { metaKey: true })), { digits: null, handled: false });
  assert.deepEqual(goToStep(null, key('5')), { digits: null, handled: false });
  const full = '1'.repeat(GO_TO_MAX_DIGITS);
  assert.equal(goToStep(full, key('2')).digits, full);
});

test('the «?» list names the new shortcut', () => {
  assert.ok(SHORTCUTS.some((s) => s.keys.startsWith('g ') && /message #/.test(s.action)));
});
