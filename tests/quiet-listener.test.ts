// hub.js wait: fast while people talk, slow after a quiet spell, so the hub's database can sleep
// (playground decision #723). hub.js runs as a script, so its pollDelay is read from the file.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../scripts/hub.js', import.meta.url), 'utf8');
const fn = /function pollDelay\([^]*?\n\}/.exec(src)?.[0] ?? '';
const pollDelay = new Function(`${fn}; return pollDelay;`)() as (last: number, now: number) => number;

test('wait asks every 3 s while the room is busy, every 6 min after 20 quiet minutes', () => {
  const t = Date.parse('2026-11-27T15:00:00Z');
  assert.equal(pollDelay(t, t + 60_000), 3000, 'a minute after the last message: busy');
  assert.equal(pollDelay(t, t + 19 * 60_000), 3000);
  assert.equal(pollDelay(t, t + 20 * 60_000), 6 * 60_000, 'twenty quiet minutes: slow');
  assert.ok(6 * 60_000 > 5 * 60_000, 'longer than Neon’s 5 idle minutes, so the database can sleep between asks');
});

test('wait keeps the time of the newest message and never sleeps past its deadline', () => {
  assert.match(src, /lastActivity = Math\.max\(lastActivity, Date\.parse\(data\.messages\.at\(-1\)\.created_at\) \|\| 0\);/);
  assert.match(src, /const pause = Math\.min\(pollDelay\(lastActivity, Date\.now\(\)\), Math\.max\(0, deadline - Date\.now\(\)\)\);/);
});

test('while waiting slowly, the listener says when it looks again (status next to the Guard), and clears it when busy', () => {
  const fnText = /function sleepText\([^]*?\n\}/.exec(src)?.[0] ?? '';
  const sleepText = new Function(`${fnText}; return sleepText;`)() as (at: number) => string;
  assert.equal(sleepText(Date.parse('2026-11-27T14:31:00Z')), '💤 looks again at 15:31');
  assert.match(src, /const slow = pause > 60_000;/);
  assert.match(src, /JSON\.stringify\(\{ text: sleepText\(Date\.now\(\) \+ pause\), ttlSeconds: Math\.ceil\(pause \/ 1000\) \+ 60 \}\)/);
  assert.match(src, /: \{ method: 'DELETE', headers: \{ Authorization: `Bearer \$\{token\}` \} \}\)\.catch\(\(\) => \{\}\);/, 'back to busy: the status goes; a failure never stops the wait');
  assert.match(src, /await fetch\(base \+ '\/api\/status', slow/, 'a plain fetch: call() would end the process on an error');
});
