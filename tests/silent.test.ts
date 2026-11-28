// The watchdog (B of playground #1509): an agent asked something that has said nothing since.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { asks, silentAgents, SILENT_AFTER_MIN } from '../lib/silent';
import { forYou } from '../lib/for-you';

const people = [
  { name: 'david', kind: 'human', label: 'David', color: 'blue' },
  { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' },
  { name: 'grok', kind: 'agent', label: 'Grok', color: 'orange' },
] as never;
const NOW = Date.parse('2026-11-28T15:10:00.000Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const m = (id: number, sender: string, text: string, minAgo: number, recipient: string | null = null) => ({ id, sender, recipient, text, room: 'main', created_at: at(minAgo) });

test('a message asks an agent when it is addressed to it or names it as @name; never its own or the hub\'s', () => {
  assert.ok(asks(m(1, 'claude', 'PR 162 is up', 0, 'grok'), 'grok'));
  assert.ok(asks(m(1, 'david', 'thanks @grok!', 0), 'grok'));
  assert.ok(!asks(m(1, 'david', 'grok said so', 0), 'grok'), 'a name without @ is not a question');
  assert.ok(!asks(m(1, 'david', 'mail me@grok.com', 0), 'grok'), 'part of an address is not a mention');
  assert.ok(!asks(m(1, 'grok', '@grok note to self', 0), 'grok'));
  assert.ok(!asks(m(1, 'hub', '@grok guard', 0), 'grok'));
});

test('silent: asked over SILENT_AFTER_MIN (5) min ago and nothing since; any message of its own wakes it', () => {
  assert.equal(SILENT_AFTER_MIN, 5, 'the experiment from #1516');
  const quiet = [m(10, 'grok', 'on it', 70), m(11, 'claude', '@grok PR 163 is up', 40), m(12, 'claude', 'and PR 164', 35, 'grok')];
  assert.deepEqual(silentAgents(quiet, people, NOW), [{ agent: 'grok', message: { id: 11, room: 'main', created_at: at(40) }, minutes: 40 }]);
  assert.deepEqual(silentAgents([...quiet, m(13, 'grok', 'reviewing now', 5)], people, NOW), [], 'it spoke: awake');
  assert.deepEqual(silentAgents([m(11, 'claude', '@grok PR 163', SILENT_AFTER_MIN - 1)], people, NOW), [], 'not yet 5 min');
  assert.deepEqual(silentAgents([m(11, 'david', 'to everyone, no name', 90)], people, NOW), [], 'not asked');
});

test('the orchestrator sees a silent agent in «for you», with the message to jump to; an agent doesn\'t', () => {
  const input = { participants: people, decisions: [], roadmap: [], flights: [], merged: new Set<number>(), repo: null, now: NOW, messages: [m(11, 'claude', '@grok PR 163 is up', 40)] };
  const items = forYou({ ...input, me: 'david' });
  assert.deepEqual(items.map((i) => [i.kind, i.key, i.text, i.message]), [['silent', 'silent-grok', 'Grok silent 40 min since #11: its listener may have stopped', { id: 11, room: 'main' }]]);
  assert.deepEqual(forYou({ ...input, me: 'claude' }), []);
});
