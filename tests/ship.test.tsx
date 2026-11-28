// «🚀 Ship it!»: which messages get it (the PR-link gate), the toggle, the chips («go from …»,
// or «shipped» only when the PR is known to be merged), the reaction row not showing the 🚀 twice,
// and the 🚀 go stored through the reactions store (memory and PGlite).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import type { Message } from '../lib/core';
import type { Participant } from '../lib/shared';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { linksPullRequest, pullRequestNumbers } from '../app/links';
import { formatClock, shipChipText } from '../lib/build-it';
import { SHIP_EMOJI, SHIP_HELP, SHIPPED_HELP, ShipIt, shipToggle, shippersOf, shipGoesOf } from '../app/ship';
import { ReactionBar } from '../app/reactions';
import { canonicalEmoji } from '../app/emoji-data';

const REPO = 'zu-dritt/trialog';
const AT = '2026-11-27T12:48:00.000Z'; // 13:48 Europe/Zurich
const base = (over: Partial<Message> = {}): Message => ({
  id: 7, sender: 'claude', recipient: null, text: 'PR 66 is up', created_at: '2026-11-27T07:00:00.000Z',
  pinned_at: null, room: 'main', attachments: [], reply_to: null, poll: null, reactions: [], ...over,
});
const people: Participant[] = [
  { name: 'david', label: 'Orchestrator', kind: 'human', color: 0 },
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
  assert.deepEqual(pullRequestNumbers('PR 62 and PR 63', REPO), [62, 63]);
  assert.deepEqual(pullRequestNumbers('PR 62 and https://github.com/zu-dritt/trialog/pull/62', REPO), [62], 'the same number once');
  assert.deepEqual(pullRequestNumbers('PR 62 is ready', null), []);
  assert.deepEqual(pullRequestNumbers('https://github.com/zu-dritt/trialog/pull/62', null), [62]);
});

test('a name in front of «PR 36», or a bare address of another repo, is not Ship it for this hub', async () => {
  const { prefixesOf } = await import('../app/links');
  const { ownPrs } = await import('../app/merged');
  const prefixes = prefixesOf('other-repo=example/other-repo,hub=example/hub,tools=example/tools');
  const HUB = 'example/hub';
  assert.equal(linksPullRequest('other-repo PR 36 is ready', HUB, prefixes), false, 'another repo is not Ship it for this hub');
  assert.equal(linksPullRequest('hub PR 36 is ready', HUB, prefixes), true);
  assert.deepEqual(pullRequestNumbers('other-repo PR 36 and PR 95 and hub PR 7', HUB, prefixes), [95, 7]);
  assert.deepEqual(pullRequestNumbers('https://github.com/example/other-repo/pull/36', HUB, prefixes), [], 'a bare address of another repo is not ours');
  assert.equal(linksPullRequest('https://github.com/example/other-repo/pull/36', HUB, prefixes), false);
  assert.deepEqual(ownPrs('other-repo PR 36 and PR 95', HUB, prefixes), [95], 'a prefixed name is not one of this hub\'s PRs');
  assert.deepEqual(ownPrs('tools PR 36 and PR 95', HUB, prefixes), [95], 'even a name without a hyphen, when it maps elsewhere');
  assert.deepEqual(ownPrs('hub PR 7 and PR 95', HUB, prefixes), [7, 95], 'a name that maps to this hub still counts');
});

test('the go is a 🚀 reaction the reactions API accepts', () => {
  assert.equal(canonicalEmoji(SHIP_EMOJI), SHIP_EMOJI);
});

test('the toggle: ship when you have not, take it back when you have, nothing without a token', () => {
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david'], at: [AT] }, { emoji: '👍', by: ['grok'] }] });
  assert.deepEqual(shippersOf(m), ['david']);
  assert.deepEqual(shipGoesOf(m), [{ name: 'david', at: AT }]);
  assert.deepEqual(shipToggle(m, 'grok'), { emoji: SHIP_EMOJI, on: true });
  assert.deepEqual(shipToggle(m, 'david'), { emoji: SHIP_EMOJI, on: false });
  assert.equal(shipToggle(m, null), null);
  assert.deepEqual(shippersOf(base()), []);
});

test('the chip says «🚀 go from Orchestrator · HH:MM», not «shipped it»', () => {
  assert.equal(formatClock(AT), '13:48');
  assert.equal(shipChipText('Orchestrator', AT), '🚀 go from Orchestrator · 13:48');
  assert.equal(shipChipText('Orchestrator', AT, true), '🚀 shipped · 13:48');
  assert.equal(shipChipText('Orchestrator'), '🚀 go from Orchestrator');
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david', 'claude'], at: [AT, '2026-11-27T13:00:00.000Z'] }] });
  const out = renderToStaticMarkup(<ShipIt message={m} me="claude" participants={people} onToggle={() => {}} />);
  assert.match(out, /🚀 Ship it!/);
  assert.match(out, /aria-pressed="true"/, 'Claude has given a go, so the button is highlighted');
  assert.match(out, /🚀 go from Orchestrator · 13:48/);
  assert.match(out, /🚀 go from Claude · 14:00/);
  assert.ok(!out.includes('shipped it'), 'clicking is a go, not a ship');
  assert.ok(out.includes(`title="${SHIP_HELP.replace("'", '&#x27;')}"`), out);
  const fresh = renderToStaticMarkup(<ShipIt message={base()} me="grok" participants={people} onToggle={() => {}} />);
  assert.match(fresh, /aria-pressed="false"/);
  assert.ok(!fresh.includes('go from'));
});

test('the chip says «shipped» only when the pull request is known to be merged', () => {
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david'], at: [AT] }] });
  const go = renderToStaticMarkup(<ShipIt message={m} me="david" participants={people} onToggle={() => {}} />);
  assert.match(go, /🚀 go from Orchestrator · 13:48/);
  assert.ok(!go.includes('🚀 shipped'));
  const done = renderToStaticMarkup(<ShipIt message={m} me="david" participants={people} onToggle={() => {}} merged />);
  assert.match(done, /🚀 shipped · 13:48/);
  assert.ok(!done.includes('go from'));
});

test('once the pull request is merged, Ship it greys out: nothing left to give a go for', () => {
  const open = renderToStaticMarkup(<ShipIt message={base()} me="david" participants={people} onToggle={() => {}} merged={false} />);
  assert.ok(!/disabled=""/.test(open) && !open.includes('data-merged'), 'an open PR: the button works');
  const done = renderToStaticMarkup(<ShipIt message={base()} me="david" participants={people} onToggle={() => {}} merged />);
  assert.match(done, /disabled=""/);
  assert.match(done, /data-merged=""/);
  assert.match(done, /opacity-50/);
  assert.ok(done.includes(`title="${SHIPPED_HELP}"`), done);
});

test('the reaction row leaves out the 🚀 it shows as chips, and keeps the other pills', () => {
  const m = base({ reactions: [{ emoji: SHIP_EMOJI, by: ['david'], at: [AT] }, { emoji: '👍', by: ['grok'] }] });
  const out = renderToStaticMarkup(
    <ReactionBar message={m} me="grok" participants={people} onToggle={() => {}} hide={[SHIP_EMOJI]}>
      <ShipIt message={m} me="grok" participants={people} onToggle={() => {}} />
    </ReactionBar>,
  );
  assert.ok(!out.includes(`${SHIP_EMOJI} 1`), 'no 🚀 pill next to the chips');
  assert.match(out, /👍 1/);
  assert.equal((out.match(/go from Orchestrator/g) ?? []).length, 1);
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
  test(`${name}: several people ship, and a second tap takes a go back, with a time on each go`, async () => {
    const store = await make();
    const m = await store.add({ sender: 'claude', recipient: null, text: 'PR 66 is up' });
    assert.ok(m);
    await store.addReaction(m.id, 'david', SHIP_EMOJI);
    const both = await store.addReaction(m.id, 'grok', SHIP_EMOJI);
    assert.equal(both.status, 'ok');
    if (both.status === 'ok') {
      assert.deepEqual(shippersOf(both.message), ['david', 'grok']);
      const goes = shipGoesOf(both.message);
      assert.equal(goes.length, 2);
      assert.ok(goes.every((g) => g.at && !Number.isNaN(Date.parse(g.at))), 'each go has a time');
    }
    const back = await store.removeReaction(m.id, 'david', SHIP_EMOJI);
    assert.ok(back);
    assert.deepEqual(shippersOf(back), ['grok']);
  });
}

test('the go chip reads as text, not as a button (no pill border)', () => {
  const html = renderToStaticMarkup(<ShipIt message={{ id: 1, text: 'PR 1', reactions: [{ emoji: '🚀', by: ['david'] }] } as never} me="david" onToggle={() => {}} />);
  const chip = /<span[^>]*data-shipped="david"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(chip, html);
  assert.doesNotMatch(chip, /rounded-full|border/);
});
