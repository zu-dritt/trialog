// The Pinned bar shows a short title instead of the start of the text, with ✎ to edit it.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PinnedBar } from '../app/pins';
import type { Message } from '../lib/core';
import type { Participant } from '../lib/shared';

const PARTICIPANTS: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0 },
  { name: 'claude', kind: 'agent', color: 1 },
  { name: 'david', kind: 'human', color: 2 },
];
const AT = '2026-11-26T09:00:00.000Z';
const message = (over: Partial<Message>): Message => ({
  id: 1, sender: 'claude', recipient: 'david', text: '', created_at: AT, pinned_at: AT, pin_title: null, room: 'main',
  attachments: [], reply_to: null, poll: null, reactions: [], ...over,
});

test('the Pinned bar shows the title instead of the text start, with an edit control', () => {
  const pinned = [
    message({ id: 107, pin_title: 'Roadmap board', text: 'The board, redrawn from the real state at 06:10.' }),
    message({ id: 132, pin_title: 'How to give feedback and report bugs', text: 'Gladly, since you ask. Your half is already good.' }),
  ];
  const html = renderToStaticMarkup(
    <PinnedBar pinned={pinned} names={['grok', 'claude', 'david']} participants={PARTICIPANTS} onJump={() => {}} onSaveTitle={() => {}} />,
  );
  assert.match(html, /<h2[^>]*>Pinned<\/h2>/);
  assert.match(html, /Roadmap board/);
  assert.match(html, /How to give feedback and report bugs/);
  assert.doesNotMatch(html, /The board, redrawn/);
  assert.doesNotMatch(html, /Gladly, since you ask/);
  assert.match(html, /#107/);
  assert.match(html, /#132/);
  assert.match(html, /Claude/);
  assert.match(html, /aria-label="Edit title of #107"/);
  assert.match(html, /✎/);
});

test('a pin without a title shows the start of the text until one is set', () => {
  const pinned = [
    message({ id: 107, pin_title: null, text: 'The board, redrawn from the real state at 06:10.' }),
  ];
  const html = renderToStaticMarkup(
    <PinnedBar pinned={pinned} names={['grok', 'claude', 'david']} participants={PARTICIPANTS} onJump={() => {}} onSaveTitle={() => {}} />,
  );
  assert.match(html, /The board, redrawn from the real state at 06:10\./);
  assert.match(html, /aria-label="Edit title of #107"/);
});
