// The Decision badge, as far as it can be checked without a browser: which messages are
// decisions, what the list of pinned messages is called, and the markup of the badge. How the
// badge sits in a message's header line and in the list is looked at by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionBadge, isDecision, pinnedListTitle } from '../app/decision';
import { parseMessageInput } from '../lib/core';

const DECISIONS = [
  'DECISION: ship v1',
  '  DECISION: ship v1',
  '\n\nDECISION: ship v1\nand more below',
  '@grok DECISION: ship v1',
  '@claude, DECISION: ship v1',
  '@david: DECISION: ship v1',
  '@grok\nDECISION: ship v1',
  'DECISION:',
];
const NOT_DECISIONS = [
  'We should ship v1',
  'no DECISION: yet',
  'decision: ship v1',
  'Decision: ship v1',
  'DECISION ship v1',
  '@nobody DECISION: ship v1',
  // The server's rule wants the name in small letters here, so the page does too.
  '@GROK DECISION: ship v1',
  'First line\nDECISION: ship v1',
  '✅ DECISION: ship v1',
  '',
];

// The names that apply when PARTICIPANTS is not set.
const THREE = ['grok', 'claude', 'david'];

test('a message is a decision when it starts with DECISION:, after an optional @name', () => {
  for (const text of DECISIONS) assert.equal(isDecision(text, THREE), true, JSON.stringify(text));
  for (const text of NOT_DECISIONS) assert.equal(isDecision(text, THREE), false, JSON.stringify(text));
});

test('the page and the server agree on what a decision is', () => {
  // The server pins a message by this rule when it is posted (lib/core.ts). None of these texts
  // opens with a quote, which is the one case where the page looks further than the server.
  for (const text of [...DECISIONS, ...NOT_DECISIONS].filter((t) => t.trim() !== '')) {
    const parsed = parseMessageInput({ text }, THREE);
    assert.ok(parsed.ok, JSON.stringify(text));
    assert.equal(isDecision(text, THREE), parsed.pinned, JSON.stringify(text));
  }
});

test('a quote at the top is skipped; a DECISION: inside a quote does not count', () => {
  // A decision that opens with the message it answers.
  assert.equal(isDecision('> **Grok** in #45:\n>\n> Which storage do we use?\n\nDECISION: Postgres', THREE), true);
  assert.equal(isDecision('> **Grok** in #45:\n>\n> Which storage?\n\n@grok DECISION: Postgres', THREE), true);
  // Quoting a decision is not deciding.
  assert.equal(isDecision('> **Grok** in #45:\n>\n> DECISION: Postgres\n\nI am not sure about this.', THREE), false);
  assert.equal(isDecision('> DECISION: Postgres', THREE), false);
  assert.equal(isDecision('>DECISION: Postgres\n>\n> more', THREE), false);
});

test('pinned by hand is not a decision', () => {
  // What makes a decision is its text. Whether a message is pinned plays no part.
  const byHand = { id: 7, text: 'The address of the test page is in the README.', pinned_at: '2026-11-25T13:00:00Z' };
  const unpinnedDecision = { id: 8, text: 'DECISION: ship v1', pinned_at: null };
  assert.equal(isDecision(byHand.text, THREE), false);
  assert.equal(isDecision(unpinnedDecision.text, THREE), true);
});

test('the list is called by what it holds', () => {
  const decision = { text: 'DECISION: ship v1' };
  const addressed = { text: '@grok DECISION: use Postgres' };
  const byHand = { text: 'The address of the test page is in the README.' };
  assert.equal(pinnedListTitle([decision], THREE), 'Decisions');
  assert.equal(pinnedListTitle([decision, addressed], THREE), 'Decisions');
  assert.equal(pinnedListTitle([decision, byHand], THREE), 'Decisions and pinned');
  assert.equal(pinnedListTitle([byHand, addressed, byHand], THREE), 'Decisions and pinned');
  assert.equal(pinnedListTitle([byHand], THREE), 'Pinned');
  assert.equal(pinnedListTitle([byHand, byHand], THREE), 'Pinned');
});

test('the badge is a label with the word and a drawn check mark, not an emoji', () => {
  const html = renderToStaticMarkup(<DecisionBadge />);
  // The word is there as text, so a screen reader says it and a search finds it.
  assert.match(html, /^<span [^>]*>.*Decision<\/span>$/);
  assert.equal(html.replace(/<[^>]+>/g, ''), 'Decision');
  // The check mark is a drawing inside the badge, hidden from screen readers: the word says it all.
  assert.match(html, /<svg aria-hidden="true"[^>]*><path [^>]*><\/path><\/svg>/);
  // Styled as a label: a border and a background of its own.
  assert.match(html, /class="[^"]*\bborder\b[^"]*\bbg-decision\/10\b/);
  // The page can add a class of its own, to show the badge in one place on a wide screen and another on a narrow one.
  assert.match(renderToStaticMarkup(<DecisionBadge className="max-sm:hidden" />), /class="[^"]* text-decision max-sm:hidden"/);
  // No emoji stands for a decision: neither a check-mark emoji nor the pin.
  for (const sign of ['✅', '✔', '☑', '✓', '📌']) assert.ok(!html.includes(sign), sign);
});
