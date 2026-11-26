// The bar at the top of a pane: which pinned messages stand in it, what the fold button says,
// and the markup of the bar and of the folded list. How it looks on a phone is checked by hand.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../lib/core';
import type { DecisionCard } from '../lib/shared';
import { FoldedList, PinnedBar, agreedWhen, cardIsAgreed, foldLabel, splitPinned } from '../app/pinned-bar';

const THREE = ['grok', 'claude', 'david'];

const card = (id: number, prompt: string, agreed_at: string | null = null, positions: DecisionCard['positions'] = []): DecisionCard => ({
  id: `decision_${id}`, message_id: id, creator: 'david', prompt, created_at: '2026-11-27T06:00:00.000Z', agreed_at, positions,
});

const message = (id: number, text: string, decision: DecisionCard | null = null, sender = 'david'): Message => ({
  id, sender, recipient: null, text, created_at: '2026-11-27T06:00:00.000Z', pinned_at: '2026-11-27T06:00:00.000Z',
  room: 'main', attachments: [], reply_to: null, decision, reactions: [],
});

const agreeAll = THREE.map((participant) => ({ participant, stance: 'agree' as const, note: null, updated_at: '2026-11-27T06:00:00.000Z' }));

const look = { names: THREE, color: () => '#fff', shown: (name: string) => name[0].toUpperCase() + name.slice(1), onJump: () => {} };

test('a card is agreed when the server stamped it or when everyone on the roster agreed', () => {
  assert.equal(cardIsAgreed(card(1, 'x'), THREE), false);
  assert.equal(cardIsAgreed(card(1, 'x', '2026-11-27T07:00:00.000Z'), THREE), true);
  assert.equal(cardIsAgreed(card(1, 'x', null, agreeAll), THREE), true);
  assert.equal(cardIsAgreed(card(1, 'x', null, agreeAll.slice(0, 2)), THREE), false);
});

test('pinned messages split into open decisions, decided ones and the rest, in their order', () => {
  const list = [
    message(1, 'DECISION: open one', card(1, 'Open one?')),
    message(2, 'just pinned'),
    message(3, 'DECISION: done', card(3, 'Done?', '2026-11-27T07:00:00.000Z')),
    message(4, 'DECISION: a line without a card'),
    message(5, 'DECISION: open two', card(5, 'Open two?', null, agreeAll.slice(1))),
  ];
  const split = splitPinned(list, THREE);
  assert.deepEqual(split.open.map((m) => m.id), [1, 5]);
  assert.deepEqual(split.decided.map((m) => m.id), [3]);
  assert.deepEqual(split.pinned.map((m) => m.id), [2, 4]);
});

test('the fold button leaves out a count of zero, and there is none when both are zero', () => {
  assert.equal(foldLabel(3, 2), '📌 3 pinned · ✓ 2 decided');
  assert.equal(foldLabel(3, 0), '📌 3 pinned');
  assert.equal(foldLabel(0, 1), '✓ 1 decided');
  assert.equal(foldLabel(0, 0), null);
});

test('when a card was agreed reads in Swiss time, and is empty without a stamp', () => {
  assert.equal(agreedWhen({ agreed_at: null }), '');
  assert.equal(agreedWhen({ agreed_at: 'not a date' }), '');
  assert.match(agreedWhen({ agreed_at: '2026-11-27T20:04:00.000Z' }), /^\d\d\.\d\d\.?,? \d\d:\d\d$/);
});

test('no open decision and nothing pinned: no bar at all', () => {
  assert.equal(renderToStaticMarkup(<PinnedBar list={[]} {...look} />), '');
});

test('open decisions stand in the bar with their prompt; the rest is one folded button', () => {
  const html = renderToStaticMarkup(
    <PinnedBar list={[message(1, 'DECISION: x', card(1, 'Ship it?')), message(2, 'pinned note'), message(3, 'DECISION: y', card(3, 'Done?', '2026-11-27T07:00:00.000Z'))]} {...look} />,
  );
  assert.match(html, /href="#m-1"[^>]*>Ship it\?<\/a>/);
  assert.match(html, /📌 1 pinned · ✓ 1 decided ▾/);
  assert.match(html, /aria-expanded="false"/);
  // Folded: the other messages are not listed.
  assert.doesNotMatch(html, /pinned note/);
  assert.doesNotMatch(html, /Done\?/);
});

test('only folded things: a thin row with just the button', () => {
  const html = renderToStaticMarkup(<PinnedBar list={[message(2, 'pinned note')]} {...look} />);
  assert.match(html, /py-1"/);
  assert.doesNotMatch(html, /Decisions waiting for agreement/);
  assert.match(html, /📌 1 pinned ▾/);
});

test('only open decisions: no fold button', () => {
  const html = renderToStaticMarkup(<PinnedBar list={[message(1, 'DECISION: x', card(1, 'Ship it?'))]} {...look} />);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Ship it\?/);
});

test('the folded list has a Decided and a Pinned group, each line a link to its message', () => {
  const html = renderToStaticMarkup(
    <FoldedList id="f" {...look} decided={[message(3, 'DECISION: y', card(3, 'Done?', '2026-11-27T07:00:00.000Z'))]} pinned={[message(2, 'pinned note\nsecond line', null, 'grok')]} />,
  );
  assert.match(html, />Decided</);
  assert.match(html, /href="#m-3"[^>]*>Done\?<\/a>/);
  assert.match(html, /agreed \d\d\.\d\d/);
  assert.match(html, />Pinned</);
  assert.match(html, /href="#m-2"/);
  assert.match(html, />Grok</);
  assert.match(html, />pinned note</);
  assert.doesNotMatch(html, /second line/);
});

test('an empty group is left out of the folded list', () => {
  const html = renderToStaticMarkup(<FoldedList id="f" {...look} decided={[]} pinned={[message(2, 'pinned note')]} />);
  assert.doesNotMatch(html, />Decided</);
});
