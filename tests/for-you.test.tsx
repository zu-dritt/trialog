// «What waits on you» (#1462–#1464): what goes on the list, in which order, and the button.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { forYou, forYouPushText } from '../lib/for-you';
import { ForYouList, forYouLabel, newWaits } from '../app/for-you';
import type { RoadmapItem } from '../lib/roadmap';

const people = [
  { name: 'david', kind: 'human', label: 'David', color: 'blue' },
  { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' },
  { name: 'grok', kind: 'agent', label: 'Grok', color: 'orange' },
] as never;
const card = (id: string, over: Partial<RoadmapItem>): RoadmapItem => ({ id, column: 'next', position: 0, title: `T ${id}`, note: '', owner: null, updated_by: 'claude', updated_at: '2026-11-28T10:00:00.000Z', progress: null, status: '', progress_at: null, description: '', attachments: [], reviewer: null, raised_by: null, moved_by: null, moved_at: null, entered_next_at: null, ...over });
const decision = (message_id: number, positions: { participant: string; stance: string }[], created_at: string, agreed_at: string | null = null) =>
  ({ decision: { id: `d${message_id}`, message_id, prompt: '@david Ship v0.4?', creator: 'grok', positions, agreed_at, created_at }, recipient: null, room: 'main' }) as never;

const base = {
  participants: people,
  decisions: [
    decision(10, [{ participant: 'grok', stance: 'agree' }], '2026-11-28T09:00:00.000Z'),
    decision(11, [{ participant: 'david', stance: 'agree' }], '2026-11-28T09:30:00.000Z'),
    decision(12, [], '2026-11-28T08:00:00.000Z', '2026-11-28T08:05:00.000Z'),
  ],
  roadmap: [
    card('rm_wait0000', { note: '⛔ WAITING ON DAVID: API key in Vercel', updated_at: '2026-11-28T11:00:00.000Z' }),
    card('rm_done0000', { note: '⛔ WAITING ON DAVID: merge PR 140', updated_at: '2026-11-28T07:00:00.000Z' }),
    card('rm_fine0000', { note: 'in review' }),
  ],
  flights: [
    { participant: 'grok', state: 'waiting', text: 'David: merge PR 160', since: '2026-11-28T10:30:00.000Z', updated_at: '2026-11-28T10:30:00.000Z', last_message_at: null },
    { participant: 'claude', state: 'working', text: 'building', since: '2026-11-28T10:00:00.000Z', updated_at: '2026-11-28T10:00:00.000Z', last_message_at: null },
  ] as never,
  merged: new Set([140]),
  repo: 'zu-dritt/trialog',
  now: Date.parse('2026-11-28T12:00:00.000Z'),
};

test('the list: unanswered decisions, cards and agents waiting on you, oldest first; settled ones left out', () => {
  const items = forYou({ ...base, me: 'david' });
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [
    ['decision', 'Agree or Object: Ship v0.4?'],
    ['flight', 'Grok waits: merge PR 160'],
    ['card', 'Card: T rm_wait0000 (⛔ WAITING ON DAVID: API key in Vercel)'],
  ]);
  assert.deepEqual(items[0].message, { id: 10, room: 'main' }, 'a decision jumps to its message');
  assert.equal(items[2].href, '/roadmap#rm_wait0000');
});

test('an agent sees only the decisions it hasn\'t answered', () => {
  const items = forYou({ ...base, me: 'claude' });
  assert.deepEqual(items.map((i) => i.kind), ['decision', 'decision']);
});

test('the list in the header', () => {
  assert.equal(forYouLabel(3), '⛔ 3 for you');
  const html = renderToStaticMarkup(<ForYouList items={forYou({ ...base, me: 'david' })} onMessage={() => {}} />);
  assert.match(html, /data-kind="decision"[^]*<button/);
  assert.match(html, /href="\/roadmap#rm_wait0000" target="trialog-roadmap"/);
});

test('each item keeps its key between polls: the decision, the card or the agent', () => {
  assert.deepEqual(forYou({ ...base, me: 'david' }).map((i) => i.key), ['decision-d10', 'flight-grok', 'card-rm_wait0000']);
});

test('the morning push: the count and the oldest item, cut for a lock screen', () => {
  const items = forYou({ ...base, me: 'david' });
  assert.equal(forYouPushText(items), '⛔ 3 for you. Oldest: Agree or Object: Ship v0.4?');
  assert.equal(forYouPushText(items.slice(1, 2)), '⛔ 1 for you: Grok waits: merge PR 160');
  const long = forYouPushText([{ ...items[0], text: 'x'.repeat(300) }]);
  assert.ok([...long].length < 140 && long.endsWith('…'));
});

test('the sound rings only for a wait that is new since the last poll, never for what was there on load', () => {
  const items = forYou({ ...base, me: 'david' });
  assert.equal(newWaits(null, items), 0, 'the first poll is what was already there');
  const seen = new Set(items.slice(0, 2).map((i) => i.key));
  assert.equal(newWaits(seen, items), 1, 'the card that joined');
  assert.equal(newWaits(new Set(items.map((i) => i.key)), items.slice(1)), 0, 'one went away: quiet');
});
