// Reaction bar rendering, allow-list helpers, and since-poll merging.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { REACTION_HINT, type Message } from '../lib/core';
import { ReactionBar, applyReactionList, replaceMatching, QUICK_REACTIONS } from '../app/reactions';
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

test('ReactionBar renders existing pills, the smiley, and escaped names', () => {
  const m = base({
    reactions: [{ emoji: '👍', by: ['david', 'claude'] }, { emoji: '❤️', by: ['grok'] }],
  });
  const out = renderToStaticMarkup(<ReactionBar message={m} me="claude" onToggle={() => {}} />);
  assert.match(out, /aria-label="Add a reaction"/);
  assert.match(out, /aria-pressed="true"/, 'Claude has already reacted with 👍');
  assert.match(out, /👍 2/);
  assert.match(out, /❤️ 1/);
  assert.match(out, /aria-label="👍, 2, David, you"/);
  assert.ok(!out.includes(REACTION_HINT), 'the hint is inside the closed picker');
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
