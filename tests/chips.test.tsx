// The row above the message box: the reply marker, quotes and images are one kind of thing to
// the writer, so they must look and behave as one. This checks that they are built from the same
// chip, not three look-alikes that can drift apart.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftChips } from '../app/attachments';
import { Chip, ChipRow } from '../app/chips';
import { QuoteChips } from '../app/quote';
import { ReplyingTo } from '../app/replies';

const reply = <ReplyingTo parent={{ id: 45, text: 'Which storage do we use?' }} author="Grok" onCancel={() => {}} />;
const quotes = <QuoteChips quotes={[{ key: 1, author: 'Claude', messageId: 46, kind: 'selection', text: 'the database for now' }]} onRemove={() => {}} />;
const images = <DraftChips drafts={[{ key: 1, name: 'shot.png', preview: 'blob:local-1', state: 'uploading' }]} onRemove={() => {}} />;

/** What React renders, without the preload hint it puts in front of markup that holds an image. */
const render = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/^(<link [^>]*\/>)+/, '');

/** The class lists of the chip itself, its text and its remove button. */
function look(markup: string) {
  const li = /^<li class="([^"]*)"/.exec(markup)?.[1];
  const text = /<span class="(min-w-0[^"]*)"/.exec(markup)?.[1];
  const button = /<button type="button" aria-label="[^"]*" title="[^"]*" class="([^"]*)">×<\/button><\/li>$/.exec(markup)?.[1];
  return { li, text, button };
}

test('the reply marker, a quote and an image are the same chip', () => {
  const [a, b, c] = [reply, quotes, images].map((element) => look(render(element)));
  assert.ok(a.li && a.text && a.button, 'each is a list item with one line of text and a remove button at its end');
  assert.deepEqual(b, a, 'a quote looks like the reply marker');
  assert.deepEqual(c, a, 'an image looks like both');
});

test('every chip has a remove button that says what it removes', () => {
  const out = render(<ChipRow>{reply}{quotes}{images}</ChipRow>);
  assert.match(out, /^<ul [^>]*aria-label="Attached to this message"/);
  assert.equal((out.match(/<li[ >]/g) ?? []).length, 3, 'one row, three chips, in this order: answer, quotes, images');
  const labels = [...out.matchAll(/<button type="button" aria-label="([^"]*)" title="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(labels.map((l) => l[0]), ['Cancel the reply', 'Remove the quote from Claude, #46', 'Remove image shot.png']);
  assert.ok(labels.every(([label, title]) => label === title), 'the tooltip says the same as the label');
  assert.ok(out.indexOf('Replying to') < out.indexOf('Claude') && out.indexOf('Claude') < out.indexOf('uploading'));
});

test('a chip: one line that is cut when too long, a tooltip for the rest, a mark when it will not be sent', () => {
  const out = renderToStaticMarkup(<Chip visual="↳" title="the whole text" onRemove={() => {}} removeLabel="Remove it">first words</Chip>);
  assert.match(out, /<span aria-hidden="true"[^>]*>↳<\/span>/, 'the sign in front is decoration');
  assert.match(out, /<span class="[^"]*truncate[^"]*" title="the whole text">first words<\/span>/);
  assert.ok(!out.includes('border-bad'));
  assert.ok(renderToStaticMarkup(<Chip tone="bad" onRemove={() => {}} removeLabel="Remove it">failed</Chip>).includes('border-bad'));
});
