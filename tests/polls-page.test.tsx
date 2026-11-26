// Component rendering for poll cards and the composer, plus merging tallies into messages.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PollCard, PollComposer, myVote, withPolls } from '../app/polls';
import type { Message } from '../lib/core';
import { VOTE_HINT, type Poll } from '../lib/shared';

const poll: Poll = {
  id: 'poll_aaaabbbbccccddddeeeeffff',
  message_id: 12,
  creator: 'david',
  question: '<script>alert(1)</script> Lunch?',
  options: [
    { index: 1, text: 'Pizza', votes: 1, voters: ['grok'] },
    { index: 2, text: '<b>Salad</b>', votes: 2, voters: ['claude', 'david'] },
  ],
  closed_at: null,
  created_at: '2026-11-26T04:00:00.000Z',
};

test('myVote and withPolls identify the caller and update an existing message', () => {
  assert.equal(myVote(poll, 'david'), 2);
  assert.equal(myVote(poll, 'grok'), 1);
  assert.equal(myVote(poll, 'claude'), 2);
  assert.equal(myVote(poll, null), null);

  const messages: Message[] = [
    { id: 12, sender: 'david', recipient: null, text: 'Lunch?', created_at: poll.created_at, pinned_at: null, attachments: [], reply_to: null, poll: null },
    { id: 13, sender: 'grok', recipient: null, text: 'hi', created_at: poll.created_at, pinned_at: null, attachments: [], reply_to: null },
  ];
  const [updated, other] = withPolls(messages, [poll]);
  assert.equal(updated.poll?.id, poll.id);
  assert.equal(other.poll ?? null, null);
});

test('PollCard renders options, counts, voters, and escapes HTML', () => {
  const out = renderToStaticMarkup(<PollCard poll={poll} me="grok" onVote={() => {}} onClose={() => {}} />);
  assert.match(out, /aria-label="Poll: /);
  assert.match(out, /Pizza/);
  assert.match(out, /Grok/);
  assert.match(out, /Claude/);
  assert.match(out, /David/);
  assert.match(out, /aria-pressed="true"/);
  assert.match(out, /aria-pressed="false"/);
  assert.match(out, /Vote for 2\. /);
  assert.match(out, /Withdraw vote for 1\. /);
  assert.ok(!out.includes('Close poll'), 'only the creator sees Close poll');
  const asCreator = renderToStaticMarkup(<PollCard poll={poll} me="david" onVote={() => {}} onClose={() => {}} />);
  assert.match(asCreator, /Close poll/);
  assert.ok(!out.includes('<script'), 'HTML in the question must be escaped');
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!out.includes('<b>Salad</b>'));
  assert.ok(out.includes('&lt;b&gt;Salad&lt;/b&gt;'));
});

test('PollCard hides voting and the close button when the poll is closed', () => {
  const closed = { ...poll, closed_at: '2026-11-26T05:00:00.000Z' };
  const out = renderToStaticMarkup(<PollCard poll={closed} me="david" onVote={() => {}} onClose={() => {}} />);
  assert.match(out, /Closed/);
  assert.ok(!out.includes('Close poll'));
  assert.ok(!out.includes('aria-pressed'));
  assert.ok(!out.includes('<button'), 'closed options are not buttons');
});

test('PollComposer is a labelled form with a 2-option start and an add-option control', () => {
  const out = renderToStaticMarkup(<PollComposer onCreate={() => {}} onCancel={() => {}} />);
  assert.match(out, /id="poll-composer"/);
  assert.match(out, /<legend[^>]*>Options \(2–10\)/);
  assert.match(out, /placeholder="Option 1"/);
  assert.match(out, /placeholder="Option 2"/);
  assert.match(out, /Add option/);
  assert.match(out, />Create poll</);
  assert.match(out, />Cancel</);
  assert.doesNotMatch(out, /Remove option/);
  const busy = renderToStaticMarkup(<PollComposer onCreate={() => {}} onCancel={() => {}} busy error="something went wrong" />);
  assert.match(busy, /Creating…/);
  assert.match(busy, /something went wrong/);
});

test('the poll question and options are message-sized; counts and names stay small', () => {
  const out = renderToStaticMarkup(<PollCard poll={poll} me="grok" onVote={() => {}} onClose={() => {}} />);
  assert.match(out, /text-\[15px\] font-semibold/);
  assert.match(out, /text-\[15px\] leading-\[1\.5\]">Pizza/);
  assert.match(out, /text-\[15px\] leading-\[1\.5\]">/);
  assert.ok(!out.includes('text-sm font-semibold'), 'the question is not the smaller text-sm size');
  // Counts and voter names stay text-xs.
  assert.match(out, /text-xs text-muted"[^>]*>[\s\S]*Grok/);
  assert.match(out, /tabular-nums font-semibold text-fg">1</);
});

test('the poll card has one quiet line about what a vote means', () => {
  const out = renderToStaticMarkup(<PollCard poll={poll} me="grok" onVote={() => {}} onClose={() => {}} />);
  assert.ok(out.includes(VOTE_HINT));
  assert.ok(out.includes(`text-xs text-muted">${VOTE_HINT}</p>`), out);
});
