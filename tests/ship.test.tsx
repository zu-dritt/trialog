// «🚀 Ship it!»: which messages get it (the PR-link gate), the toggle, the chips, the reaction row
// not showing the 🚀 twice, and the 🚀 go stored through the reactions store (memory and PGlite).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import type { Participant } from '../lib/shared';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { linksPullRequest } from '../app/links';
import { SHIP_EMOJI, SHIP_HELP, ShipIt, shipToggle, shippersOf } from '../app/ship';
import { ReactionBar } from '../app/reactions';
import { canonicalEmoji } from '../app/emoji-data';

const REPO = 'zu-dritt/trialog';
const base = (over: Partial<Message> = {}): Message => ({
  id: 7, sender: 'claude', recipient: null, text: 'PR 66 is up', created_at: '2026-11-27T07:00:00.000Z',
  pinned_at: null, room: 'main', attachments: [], reply_to: null, poll: null, reactions: [], ...over,
});
const people: Participant[] = [
  { name: 'david', label: 'David', kind: 'human', color: 0 },
  { name: 'claude', label: 'Claude', kind: 'agent', color: 1 },
  { name: 'grok', label: 'Grok', kind: 'agent', color: 2 },
];

test('the gate: «PR N», «PR #N», «pull request N» and github.com/…/pull/N link a pull request', () => {
  for (const text of ['PR 62 is ready', 'see PR #62', 'pr#62', 'Pull request 62, please', 'Review https://github.com/zu-dritt/trialog/pull/62']) {
    assert.equal(linksPullRequest(text, REPO), true, text);
  }
});

test('the gate: other text, issues, code and words containing «pr» do not', () => {
  for (const text of ['Looks good', 'issue 5 is open', 'https://github.com/zu-dritt/trialog/issues/5', 'sprint 3', 'PRE 62',
    'run `gh pr view PR 62`', '```\nPR 62\n```', 'https://github.com/zu-dritt/trialog/pulls']) {
    assert.equal(linksPullRequest(text, REPO), false, text);
  }
});

test('the gate: without a repository «PR 62» is not a link, but a GitHub pull request address still is', () => {
  assert.equal(linksPullRequest('PR 62 is ready', null), false);
  assert.equal(linksPullRequest('https://github.com/zu-dritt/trialog/pull/62', null), true);
});

test('the go is a 🚀 reaction the reactions API accepts', () => {
  assert.equal(canonicalEmoji(SHIP_EMOJI), SHIP_EMOJI);
});

test('the toggle: ship when you have not, take it back when you have, nothing without a token', () => {
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david'] }, { emoji: '👍', by: ['grok'] }] });
  assert.deepEqual(shippersOf(m), ['david']);
  assert.deepEqual(shipToggle(m, 'grok'), { emoji: SHIP_EMOJI, on: true });
  assert.deepEqual(shipToggle(m, 'david'), { emoji: SHIP_EMOJI, on: false });
  assert.equal(shipToggle(m, null), null);
  assert.deepEqual(shippersOf(base()), []);
});

test('the button and a chip per participant who shipped, with names and the help line', () => {
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david', 'claude'] }] });
  const out = renderToStaticMarkup(<ShipIt message={m} me="claude" participants={people} onToggle={() => {}} />);
  assert.match(out, /🚀 Ship it!/);
  assert.match(out, /aria-pressed="true"/, 'Claude has shipped, so the button is highlighted');
  assert.match(out, /🚀 David shipped it/);
  assert.match(out, /🚀 Claude shipped it/);
  assert.ok(out.includes(`title="${SHIP_HELP.replace("'", '&#x27;')}"`), out);
  const fresh = renderToStaticMarkup(<ShipIt message={base()} me="grok" participants={people} onToggle={() => {}} />);
  assert.match(fresh, /aria-pressed="false"/);
  assert.ok(!fresh.includes('shipped it'));
});

test('the reaction row leaves out the 🚀 it shows as chips, and keeps the other pills', () => {
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david'] }, { emoji: '👍', by: ['grok'] }] });
  const out = renderToStaticMarkup(
    <ReactionBar message={m} me="grok" participants={people} onToggle={() => {}} hide={[SHIP_EMOJI]}>
      <ShipIt message={m} me="grok" participants={people} onToggle={() => {}} />
    </ReactionBar>,
  );
  assert.ok(!out.includes(`${SHIP_EMOJI} 1`), 'no 🚀 pill next to the chips');
  assert.match(out, /👍 1/);
  assert.equal((out.match(/David shipped it/g) ?? []).length, 1);
  // Without the button and with nothing else to show, the row stays empty.
  assert.equal(renderToStaticMarkup(<ReactionBar message={base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david'] }] })} me="grok" onToggle={() => {}} hide={[SHIP_EMOJI]} />), '');
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const STORES: [string, () => Promise<Store>][] = [
  ['memory (demo hub)', async () => createMemoryStore()],
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
];

for (const [name, make] of STORES) {
  test(`${name}: several people ship, and a second tap takes a go back`, async () => {
    const store = await make();
    const m = await store.add({ sender: 'claude', recipient: null, text: 'PR 66 is up' });
    assert.ok(m);
    await store.addReaction(m.id, 'david', SHIP_EMOJI);
    const both = await store.addReaction(m.id, 'grok', SHIP_EMOJI);
    assert.equal(both.status, 'ok');
    if (both.status === 'ok') assert.deepEqual(shippersOf(both.message), ['david', 'grok']);
    const back = await store.removeReaction(m.id, 'david', SHIP_EMOJI);
    assert.ok(back);
    assert.deepEqual(shippersOf(back), ['grok']);
  });
}
