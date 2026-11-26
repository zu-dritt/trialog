// The human-only wake-up line: host only, never a URL or a secret.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { WakeTargetsLine, type ParticipantWithWake } from '../app/wakes';

test('the wake-up line lists hosts for a human and is hidden for an agent', () => {
  const people: ParticipantWithWake[] = [
    { name: 'ana', kind: 'human', color: 0, wake_target_host: null, wake_target_set_at: null },
    { name: 'scout', kind: 'agent', color: 1, wake_target_host: 'scout.example', wake_target_set_at: '2026-11-26T09:00:00.000Z' },
  ];
  const asHuman = renderToStaticMarkup(<WakeTargetsLine me="ana" participants={people} />);
  assert.match(asHuman, /Wake-ups:/);
  assert.match(asHuman, /Scout \(scout\.example\)/);
  assert.ok(!asHuman.includes('https://'), asHuman);
  const asAgent = renderToStaticMarkup(<WakeTargetsLine me="scout" participants={people} />);
  assert.equal(asAgent, '');
  const empty = renderToStaticMarkup(<WakeTargetsLine me="ana" participants={[{ name: 'ana', kind: 'human', color: 0, wake_target_host: null, wake_target_set_at: null }]} />);
  assert.match(empty, /none set/);
});
