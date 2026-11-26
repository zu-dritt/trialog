// Replies on the page, as far as they can be checked without a browser: the one-line excerpt of
// the answered message, and the markup of the three small pieces. Jumping to a message, the
// brief mark and the focus need a real browser and are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplyButton, ReplyContext, ReplyingTo, replyExcerpt } from '../app/replies';

const parent = { id: 45, text: 'Which storage do we use?\n\nI see two options.', attachments: [] };

test('the excerpt is the first line that says something', () => {
  assert.equal(replyExcerpt(parent), 'Which storage do we use?');
  assert.equal(replyExcerpt({ id: 1, text: '\n\n   second line is the first with text\nthird' }), 'second line is the first with text');
  // A message that opens with a quote: the excerpt is what the writer said, not what they quoted.
  assert.equal(replyExcerpt({ id: 1, text: '> **Grok** in #45:\n>\n> the quoted part\n\nMy own answer.' }), 'My own answer.');
  // Only a quote: better its text than nothing.
  assert.equal(replyExcerpt({ id: 1, text: '> just a quote' }), 'just a quote');
  // A list or heading mark at the start is dropped; a code fence line is skipped.
  assert.equal(replyExcerpt({ id: 1, text: '## The plan' }), 'The plan');
  assert.equal(replyExcerpt({ id: 1, text: '- first point\n- second' }), 'first point');
  assert.equal(replyExcerpt({ id: 1, text: '1. step one' }), 'step one');
  assert.equal(replyExcerpt({ id: 1, text: '```js\nconst a = 1;\n```' }), 'const a = 1;');
  // An image-only message is named by its images; an empty one gives nothing.
  assert.equal(replyExcerpt({ id: 1, text: '', attachments: [{ id: 'att_0123456789abcdef01234567', width: 40, height: 20 }] }), '[image: att_0123456789abcdef01234567, 40×20]');
  assert.equal(replyExcerpt({ id: 1, text: '   ' }), '');
});

test('a long line is cut to the given length with an ellipsis', () => {
  const long = 'word '.repeat(60).trim();
  const cut = replyExcerpt({ id: 1, text: long }, 40);
  assert.ok(cut.length <= 40 && cut.endsWith('…'), cut);
  assert.ok(long.startsWith(cut.slice(0, -1)));
  assert.equal(replyExcerpt({ id: 1, text: 'short' }, 40), 'short');
});

test('the line above a reply names the answered message and is a button that goes there', () => {
  const out = renderToStaticMarkup(<ReplyContext replyTo={45} parent={parent} author="Grok" authorClass="text-grok" onJump={() => {}} />);
  assert.match(out, /^<button type="button"/);
  assert.match(out, /aria-label="In reply to message #45 by Grok\. Go to it\. It says: Which storage do we use\?"/);
  assert.match(out, /title="Go to message #45"/);
  assert.match(out, /<span class="font-bold text-grok">Grok<\/span> <span>#45<\/span> <span>Which storage do we use\?<\/span>/);
  assert.match(out, /truncate/, 'one line, cut off when it is too long for the column');
});

test('the excerpt is plain text: nothing in the answered message becomes markup', () => {
  const hostile = { id: 7, text: '<img src=x onerror=alert(1)> **bold** [link](javascript:alert(1)) ![i](https://tracker.example/p.png)' };
  const out = renderToStaticMarkup(<ReplyContext replyTo={7} parent={hostile} author="Grok" onJump={() => {}} />);
  assert.ok(!/<img|<a |<strong|<em|<script/.test(out), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt; **bold** [link](javascript:alert(1))'), 'shown as the characters it is');
  const banner = renderToStaticMarkup(<ReplyingTo parent={hostile} author="Grok" onCancel={() => {}} />);
  assert.ok(!/<img|<a |<strong|<em|<script/.test(banner), banner);
});

test('a reply to a message that is not loaded shows its number and no button', () => {
  const out = renderToStaticMarkup(<ReplyContext replyTo={3} parent={undefined} onJump={() => {}} />);
  assert.ok(!out.includes('<button'));
  assert.match(out, /↳ in reply to #3/);
  assert.match(out, /title="Message #3 is not loaded on this page"/);
});

test('the composer says whom the reply answers and offers a way out', () => {
  const out = renderToStaticMarkup(<ReplyingTo parent={parent} author="Grok" onCancel={() => {}} />);
  assert.match(out, /role="group" aria-label="Reply"/);
  assert.match(out, /Replying to <span class="font-bold">Grok<\/span>, #45/);
  assert.match(out, /Which storage do we use\?/);
  assert.match(out, /<button type="button" aria-label="Cancel the reply" title="Cancel the reply"[^>]*>×<\/button>/);
});

test('the Reply action is a labelled button', () => {
  const out = renderToStaticMarkup(<ReplyButton messageId={45} onReply={() => {}} className="c" />);
  assert.equal(out, '<button type="button" aria-label="Reply to message #45" title="Reply to message #45" class="c">Reply</button>');
});
