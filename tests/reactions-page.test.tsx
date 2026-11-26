// Reaction bar rendering, allow-list helpers, and since-poll merging.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { REACTION_HINT, type Message } from '../lib/core';
import { ReactButton, ReactionBar, applyReactionList, placeReactionPanel, replaceMatching, QUICK_REACTIONS } from '../app/reactions';
import { canonicalEmoji } from '../app/emoji-data';

const base = (over: Partial<Message> = {}): Message => ({
  id: 9,
  sender: 'grok',
  recipient: null,
  text: 'Looks good',
  created_at: '2026-11-26T04:00:00.000Z',
  pinned_at: null,
  attachments: [],
  reply_to: null,
  poll: null,
  reactions: [],
  ...over,
});

test('the quick row is thumbs, heart, thumbs down, joy and party', () => {
  assert.deepEqual([...QUICK_REACTIONS], ['👍', '❤️', '👎', '😂', '🎉']);
  for (const emoji of QUICK_REACTIONS) assert.equal(canonicalEmoji(emoji), emoji);
});

test('ReactionBar renders existing pills and escaped names, and not the react button', () => {
  const m = base({
    reactions: [{ emoji: '👍', by: ['david', 'claude'] }, { emoji: '❤️', by: ['grok'] }],
  });
  const out = renderToStaticMarkup(<ReactionBar message={m} me="claude" onToggle={() => {}} />);
  assert.ok(!out.includes('Add a reaction'), out);
  assert.match(out, /aria-pressed="true"/, 'Claude has already reacted with 👍');
  assert.match(out, /👍 2/);
  assert.match(out, /❤️ 1/);
  assert.match(out, /aria-label="👍, 2, David, you"/);
  const empty = renderToStaticMarkup(<ReactionBar message={base()} me="claude" onToggle={() => {}} />);
  assert.equal(empty, '');
});

test('the react button sits in the action row and keeps the picker closed until clicked', () => {
  const out = renderToStaticMarkup(<ReactButton message={base()} me="claude" onToggle={() => {}} className="c" />);
  assert.match(out, /aria-label="Add a reaction"/);
  assert.match(out, /aria-expanded="false"/);
  assert.ok(!out.includes(REACTION_HINT), 'the hint is inside the closed picker');
});

test('the reaction panel opens below when there is room, and upward when the message box leaves none', () => {
  const panel = { width: 240, height: 96 };
  const viewport = { width: 800, height: 600 };
  // Mid-page: plenty of room above a 120px message box.
  const mid = placeReactionPanel({ top: 200, bottom: 224, left: 80 }, panel, viewport, 120);
  assert.equal(mid.placement, 'below');
  assert.equal(mid.top, 228);
  assert.equal(mid.left, 80);
  // A message just above the message box: opening below would hide the panel under it.
  const low = placeReactionPanel({ top: 450, bottom: 474, left: 80 }, panel, viewport, 120);
  assert.equal(low.placement, 'above');
  assert.equal(low.top, 450 - 4 - 96);
  assert.ok(low.top + panel.height <= viewport.height - 120, 'the panel stays above the message box');
  // A panel that would run off the right edge is kept on screen.
  const edge = placeReactionPanel({ top: 200, bottom: 224, left: 700 }, panel, viewport, 0);
  assert.equal(edge.left, 800 - 240);
  // A panel taller than the room above the message box stays above the box, even if its top is clipped.
  const tall = placeReactionPanel({ top: 80, bottom: 100, left: 80 }, { width: 240, height: 500 }, viewport, 120);
  assert.equal(tall.top + 500, 600 - 120);
  assert.ok(tall.top < 0);
});

test('applyReactionList updates and clears reactions on messages already in the list', () => {
  const a = base({ id: 1, reactions: [{ emoji: '👍', by: ['grok'] }] });
  const b = base({ id: 2, reactions: [{ emoji: '😂', by: ['david'] }] });
  const next = applyReactionList([a, b], [
    { message_id: 1, reactions: [{ emoji: '❤️', by: ['claude'] }] },
  ]);
  assert.deepEqual(next[0].reactions, [{ emoji: '❤️', by: ['claude'] }]);
  assert.deepEqual(next[1].reactions, [], 'a message missing from the payload is cleared');
});

test('replaceMatching updates existing ids and never appends', () => {
  const a = base({ id: 1, text: 'old' });
  const incoming = [base({ id: 1, text: 'new', reactions: [{ emoji: '👍', by: ['david'] }] }), base({ id: 99, text: 'other' })];
  const next = replaceMatching([a], incoming);
  assert.equal(next.length, 1);
  assert.equal(next[0].text, 'new');
  assert.deepEqual(next[0].reactions, [{ emoji: '👍', by: ['david'] }]);
});

test('the hint uses the same size as the more label, not 11px', () => {
  const src = readFileSync(new URL('../app/reactions.tsx', import.meta.url), 'utf8');
  assert.match(src, /text-xs text-muted">\{REACTION_HINT\}/);
  assert.ok(!src.includes('text-[11px]'), src);
});

test('Reply, Quote, pin and react are grouped in one action row on the message', () => {
  const src = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const row = src.match(/<div className="ml-auto flex items-baseline gap-0">([\s\S]*?)<\/div>/);
  assert.ok(row, 'the action row is one group at the right of the header');
  const body = row[1];
  assert.match(body, /<ReplyButton/);
  assert.match(body, /<QuoteMessageButton/);
  assert.match(body, />📌<\/button>/);
  assert.match(body, /<ReactButton/);
  const order = ['ReplyButton', 'QuoteMessageButton', '📌', 'ReactButton'].map((s) => body.indexOf(s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), body);
  // The smiley is no longer under the message; the pills stay there.
  assert.ok(!src.includes('>☺</button>'));
  assert.match(src, /<ReactionBar /);
});
