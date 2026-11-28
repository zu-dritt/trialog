// The health chips' rules: when the heartbeat is green, amber and grey, what counts as «heard from»,
// the one word, and when an agent is blocked on a human.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { HEARTBEAT_AMBER_MINUTES, HEARTBEAT_GREY_MINUTES, blockedOf, healthReport, heartbeatOf, lastHeard, lastMergeOf, wordOf } from '../lib/health';
import type { Flight, Participant, ParticipantStatus } from '../lib/shared';

const NOW = Date.parse('2026-11-28T09:00:00.000Z');
const min = (n: number) => n * 60_000;
const ago = (n: number) => new Date(NOW - min(n)).toISOString();
const flight = (over: Partial<Flight> = {}): Flight => ({ participant: 'claude', state: 'working', text: 'iPhone app', since: ago(5), updated_at: ago(5), last_message_at: null, ...over });
const ROSTER: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0, label: 'Grok' },
  { name: 'claude', kind: 'agent', color: 1, label: 'Claude' },
  { name: 'david', kind: 'human', color: 2, label: 'Orchestrator' },
];
const report = (over: Partial<Parameters<typeof healthReport>[0]> = {}) => healthReport({ roster: ROSTER, flights: [], statuses: [], merges: [], repo: 'zu-dritt/trialog', now: NOW, ...over });
const agent = (r: ReturnType<typeof report>, name: string) => r.agents.find((a) => a.participant === name)!;

test('the heartbeat is green under 10 minutes, amber from 10, grey from 20', () => {
  assert.equal(HEARTBEAT_AMBER_MINUTES, 10);
  assert.equal(HEARTBEAT_GREY_MINUTES, 20);
  assert.equal(heartbeatOf(0), 'green');
  assert.equal(heartbeatOf(min(9) + 59_000), 'green', '9 min 59 s: still green');
  assert.equal(heartbeatOf(min(10)), 'amber', 'exactly 10 minutes: amber');
  assert.equal(heartbeatOf(min(19) + 59_000), 'amber');
  assert.equal(heartbeatOf(min(20)), 'grey', 'exactly 20 minutes: grey');
  assert.equal(heartbeatOf(min(49)), 'grey');
  assert.equal(heartbeatOf(-min(2)), 'green', 'a clock a little ahead is just now');
  assert.equal(heartbeatOf(null), 'grey', 'never heard from');
  assert.equal(heartbeatOf(Number.NaN), 'grey');
});

test('heard from means the newest of the last message, the status and the flight', () => {
  assert.equal(lastHeard({}), null);
  assert.equal(lastHeard({ flight: flight({ updated_at: ago(30), last_message_at: ago(12) }) }), ago(12), 'a message after the flight');
  assert.equal(lastHeard({ flight: flight({ updated_at: ago(30), last_message_at: ago(40) }) }), ago(30), 'the flight after the message');
  const status = { updated_at: ago(3) } as ParticipantStatus;
  assert.equal(lastHeard({ flight: flight({ updated_at: ago(30), last_message_at: ago(40) }), status }), ago(3), 'a status is a sign of life too');
  assert.equal(lastHeard({ flight: flight({ last_message_at: null, updated_at: ago(8) }) }), ago(8), 'no message in a day');
});

test('a hung watcher goes grey on its own while its flight still says working', () => {
  // The flight was set 49 minutes ago and nothing was heard since: «working» is only what it said then.
  const hung = agent(report({ flights: [flight({ since: ago(49), updated_at: ago(49), last_message_at: ago(52) })] }), 'claude');
  assert.equal(hung.state, 'working');
  assert.equal(hung.word, 'building');
  assert.equal(hung.heartbeat, 'grey');
  assert.equal(hung.heard_ago_ms, min(49));
  // The same flight with a message two minutes ago is green.
  assert.equal(agent(report({ flights: [flight({ since: ago(49), updated_at: ago(49), last_message_at: ago(2) })] }), 'claude').heartbeat, 'green');
});

test('every agent of the roster gets a chip, heard from or not; humans get none', () => {
  const r = report({ flights: [flight()] });
  assert.deepEqual(r.agents.map((a) => a.participant), ['grok', 'claude']);
  const silent = agent(r, 'grok');
  assert.equal(silent.heard_at, null);
  assert.equal(silent.heartbeat, 'grey');
  assert.equal(silent.word, 'resting');
  assert.equal(silent.text, '');
  assert.deepEqual([agent(r, 'grok').emoji, agent(r, 'claude').emoji], ['🔥', '🛠️']);
});

test('an expired status is no sign of life', () => {
  const stale = { participant: 'grok', text: 'x', updated_at: ago(2), expires_at: ago(1) };
  assert.equal(agent(report({ statuses: [stale] }), 'grok').heard_at, null);
  assert.equal(agent(report({ statuses: [{ ...stale, expires_at: new Date(NOW + 1000).toISOString() }] }), 'grok').heartbeat, 'green');
});

test('the word: building, reviewing, waiting, resting', () => {
  assert.equal(wordOf(flight({ text: 'iPhone app' })), 'building');
  assert.equal(wordOf(flight({ text: 'Reviewing PR 127/128/129' })), 'reviewing');
  assert.equal(wordOf(flight({ text: 'review of PR 5' })), 'reviewing');
  assert.equal(wordOf(flight({ text: 'previewing the card' })), 'building', '«previewing» is not a review');
  assert.equal(wordOf(flight({ state: 'waiting', text: 'review of PR 5' })), 'waiting', 'waiting wins over the text');
  assert.equal(wordOf(flight({ state: 'idle', text: '' })), 'resting');
  assert.equal(wordOf(null), 'resting');
});

test('blocked: a waiting flight with a step for a human; not a wait on another agent, not a working flight', () => {
  const humans = ROSTER.filter((p) => p.kind === 'human');
  const none = new Set<number>();
  const wait = flight({ state: 'waiting', text: 'David: merge PR 36' });
  assert.deepEqual(blockedOf(wait, humans, none, 'zu-dritt/trialog'), { on: 'Orchestrator', text: 'merge PR 36', since: wait.since });
  assert.equal(blockedOf(flight({ state: 'waiting', text: 'Orchestrator: look at the mock' }), humans, none, null)?.on, 'Orchestrator', 'by label too');
  assert.equal(blockedOf(flight({ state: 'waiting', text: 'Grok: review of PR 127' }), humans, none, null), null, 'waiting on an agent is not blocked on a human');
  assert.equal(blockedOf(flight({ state: 'waiting', text: 'review of PR 127' }), humans, none, null), null, 'nobody named');
  assert.equal(blockedOf(flight({ state: 'working', text: 'David: merge PR 36' }), humans, none, null), null, 'only a waiting flight blocks');
  assert.equal(blockedOf(flight({ state: 'waiting', text: 'Grok: review PR 96; David: Ship it on PR 97' }), humans, none, 'zu-dritt/trialog')?.text, 'Ship it on PR 97', 'only the step for the human');
  assert.equal(blockedOf(null, humans, none, null), null);
});

test('blocked ends by itself when the PR it waits on is merged (the flight strip\'s rule)', () => {
  const humans = ROSTER.filter((p) => p.kind === 'human');
  const wait = flight({ state: 'waiting', text: 'David: Ship it on PR 97' });
  assert.ok(blockedOf(wait, humans, new Set([96]), 'zu-dritt/trialog'), 'another PR merged: still blocked');
  assert.equal(blockedOf(wait, humans, new Set([97]), 'zu-dritt/trialog'), null, 'PR 97 merged: no longer blocked');
  const decision = flight({ state: 'waiting', text: 'David: Agree on decision card #791 (PR 101)' });
  assert.ok(blockedOf(decision, humans, new Set([101]), 'zu-dritt/trialog'), 'a decision still waits, merged or not');
});

test('in the report: blocked, last merge by branch, and the word, together', () => {
  const merges = [
    { number: 131, title: 'a', merged_at: ago(300), branch: 'claude/done-newest-first' },
    { number: 133, title: 'b', merged_at: ago(70), branch: 'claude/push-logs' },
    { number: 134, title: 'c', merged_at: ago(60), branch: 'grok/push-token-regex' },
    { number: 135, title: 'd', merged_at: ago(5), branch: 'dependabot/npm/x' },
    { number: 136, title: 'no branch', merged_at: ago(1) },
  ];
  const r = report({
    merges,
    flights: [flight({ state: 'waiting', text: 'David: merge PR 140', updated_at: ago(3) }), flight({ participant: 'grok', text: 'Reviewing PR 140', updated_at: ago(12) })],
  });
  assert.deepEqual(agent(r, 'claude').last_merge, { pr: 133, merged_at: ago(70) });
  assert.deepEqual(agent(r, 'grok').last_merge, { pr: 134, merged_at: ago(60) });
  assert.equal(agent(r, 'claude').blocked?.on, 'Orchestrator');
  assert.equal(agent(r, 'claude').heartbeat, 'green');
  assert.equal(agent(r, 'grok').word, 'reviewing');
  assert.equal(agent(r, 'grok').heartbeat, 'amber');
  assert.equal(agent(r, 'grok').blocked, null);
  assert.equal(r.now, new Date(NOW).toISOString());
});

test('last merge: none when the agent has none, and a branch of another name does not count', () => {
  assert.equal(lastMergeOf('grok', []), null);
  assert.equal(lastMergeOf('grok', [{ number: 1, title: 'x', merged_at: ago(1), branch: 'grokker/x' }]), null, '«grokker/» is not «grok/»');
});
