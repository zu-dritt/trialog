// A human's go (🚀) on an agent's message also goes to that agent as a message, so it wakes them
// (playground #1023: a reaction wakes nobody, and the go on #1004 waited 20 minutes unseen).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shipNotice } from '../app/ship';

const people = [
  { name: 'david', kind: 'human' as const },
  { name: 'claude', kind: 'agent' as const },
  { name: 'grok', kind: 'agent' as const },
];

test('a human going on an agent’s message tells that agent, as a reply in the same room', () => {
  assert.deepEqual(shipNotice({ id: 1004, sender: 'claude', room: 'main' }, 'david', people), {
    text: '🚀 Ship it! Go on #1004.', to: 'claude', reply_to: 1004, room: 'main',
  });
  assert.equal(shipNotice({ id: 7, sender: 'grok', room: 'calm' }, 'david', people)?.room, 'calm');
});

test('nobody to tell: an agent’s go, a go on a human’s or the hub’s message, or no sign-in', () => {
  assert.equal(shipNotice({ id: 1, sender: 'claude', room: 'main' }, 'grok', people), null, 'an agent’s 🚀 is never a go');
  assert.equal(shipNotice({ id: 1, sender: 'david', room: 'main' }, 'david', people), null, 'own message');
  assert.equal(shipNotice({ id: 1, sender: 'hub', room: 'main' }, 'david', people), null);
  assert.equal(shipNotice({ id: 1, sender: 'claude', room: 'main' }, null, people), null);
});

test('the pane sends it only when the go is given, not when it is taken back', () => {
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /const notice = on && emoji === SHIP_EMOJI \? shipNotice\(m, me, participants\) : null;/);
  assert.match(pane, /to: notice\.to, reply_to: notice\.reply_to/);
});

test('a go message gets no «Build it» chip', async () => {
  const { isBuildableMessage } = await import('../app/build-it');
  const humans = [{ name: 'david', kind: 'human' }, { name: 'claude', kind: 'agent' }] as never;
  assert.equal(isBuildableMessage({ sender: 'david', text: '🚀 Ship it! Go on #1004.' }, humans, false), false);
  assert.equal(isBuildableMessage({ sender: 'david', text: 'A new idea for the roadmap' }, humans, false), true, 'other messages keep it');
});
