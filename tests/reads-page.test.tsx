// Read receipts and the "not seen yet" flag, as far as they can be checked without a browser.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadReceipts, UnseenFlag, UNSEEN_AFTER_MS } from '../app/reads';
import type { Participant, ReadPosition } from '../lib/shared';

const PARTICIPANTS: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0 },
  { name: 'claude', kind: 'agent', color: 1 },
  { name: 'david', kind: 'human', color: 2 },
];

test('initials appear on the last message someone else has read, not on the viewer\'s own', () => {
  const reads: ReadPosition[] = [
    { participant: 'grok', room: 'main', up_to: 9, updated_at: '2026-11-26T09:00:00.000Z' },
    { participant: 'david', room: 'main', up_to: 9, updated_at: '2026-11-26T09:00:00.000Z' },
    { participant: 'claude', room: 'main', up_to: 8, updated_at: '2026-11-26T09:00:00.000Z' },
  ];
  const html = renderToStaticMarkup(<ReadReceipts messageId={9} reads={reads} participants={PARTICIPANTS} me="david" />);
  assert.match(html, /Grok has read up to here/);
  assert.ok(!html.includes('David has read up to here'), html);
  assert.ok(!html.includes('Claude has read up to here'), html);
  assert.match(html, />G</);
  const empty = renderToStaticMarkup(<ReadReceipts messageId={7} reads={reads} participants={PARTICIPANTS} me="david" />);
  assert.equal(empty, '');
});

test('the unseen flag appears after two minutes when no addressed agent has read past the message', () => {
  const now = Date.parse('2026-11-26T09:00:00.000Z');
  const message = {
    id: 11,
    sender: 'david',
    recipient: 'grok' as const,
    created_at: new Date(now - UNSEEN_AFTER_MS - 1_000).toISOString(),
    text: 'hello',
  };
  const shown = renderToStaticMarkup(<UnseenFlag message={message} reads={[]} participants={PARTICIPANTS} now={now} />);
  assert.ok(shown.includes('⏰ not seen by Grok yet'), shown);
  assert.ok(shown.includes('title="⏰ not seen by Grok yet"'), shown);
  const seen = renderToStaticMarkup(<UnseenFlag message={message} reads={[{ participant: 'grok', room: 'main', up_to: 11, updated_at: message.created_at }]} participants={PARTICIPANTS} now={now} />);
  assert.equal(seen, '');
});
