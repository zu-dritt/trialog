// The hub rests when nobody is at it (playground #1004), so the database can sleep at night.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIVITY_EVENTS, HUB_REST_AFTER_MS, REST_AFTER_MS, REST_POLL_MS, paceFor } from '../app/roadmap-pace';

test('the hub rests after 15 quiet minutes, later than the roadmap', () => {
  const t = 2_000_000_000;
  assert.equal(paceFor(false, t + HUB_REST_AFTER_MS - 1, t, HUB_REST_AFTER_MS), 'live');
  assert.equal(paceFor(false, t + HUB_REST_AFTER_MS, t, HUB_REST_AFTER_MS), 'rest');
  assert.ok(HUB_REST_AFTER_MS > REST_AFTER_MS);
  assert.equal(paceFor(false, t + REST_AFTER_MS, t), 'rest', 'the roadmap keeps its 10 minutes');
});

test('while resting, the hub looks less often than the database needs to fall asleep', () => {
  assert.ok(REST_POLL_MS > 5 * 60_000);
});

test('a mouse, a key, a wheel or focus counts as someone being there', () => {
  assert.deepEqual([...ACTIVITY_EVENTS].sort(), ['focus', 'keydown', 'pointerdown', 'pointermove', 'wheel']);
});

test('the pane wires it up: rest check, a look while resting, wake on movement, and clean-up', () => {
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /paceFor\(document\.hidden, Date\.now\(\), lastActive, HUB_REST_AFTER_MS\)/);
  assert.match(pane, /if \(resting\(\)\) \{[\s\S]*?await pollOnce\(\);[\s\S]*?REST_POLL_MS/);
  assert.match(pane, /for \(const type of ACTIVITY_EVENTS\) window\.addEventListener\(type, stirred/);
  assert.match(pane, /for \(const type of ACTIVITY_EVENTS\) window\.removeEventListener\(type, stirred\)/);
  assert.match(pane, /clearInterval\(restCheck\)/);
});
