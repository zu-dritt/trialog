// Red clears itself when the PR merges (playground #813): a card or a flight step that waits on the
// orchestrator for PRs that are all merged is no longer red, whatever its note still says.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { allMerged } from '../app/merged';
import { waitingOn } from '../app/flight';
import type { Flight } from '../lib/shared';
import { boardStatus, shippable } from '../app/roadmap-board';
import type { RoadmapItem } from '../lib/roadmap';

const REPO = 'zu-dritt/trialog';
const NOW = Date.parse('2026-11-27T19:00:00.000Z');
const HUMANS = ['david', 'Orchestrator'];
const card = (note: string): RoadmapItem => ({
  id: 'rm_red00000', column: 'now', position: 0, title: 'Ship it on cards', note, owner: 'claude', updated_by: 'claude',
  updated_at: '2026-11-27T18:50:00.000Z', progress: null, status: '', progress_at: null, description: '', attachments: [], reviewer: 'grok', raised_by: null,
});

test('allMerged: every PR the text names is merged, and it names at least one', () => {
  assert.equal(allMerged('Ship it on PR 106', new Set([106]), REPO), true);
  assert.equal(allMerged('Ship it on PR 106 and PR 107', new Set([106]), REPO), false, 'one still open');
  assert.equal(allMerged('Agree on decision card #791', new Set([106]), REPO), false, 'no PR named: not «merged»');
});

test('a card waiting on a Ship it for a merged PR is green «merged», with no Ship it button', () => {
  const c = card('⛔ WAITING ON DAVID: 🚀 Ship it on PR 106 (https://github.com/zu-dritt/trialog/pull/106)');
  assert.equal(boardStatus(c, NOW, HUMANS, new Set(), REPO)?.tone, 'blocked', 'not merged yet: red');
  assert.deepEqual(boardStatus(c, NOW, HUMANS, new Set([106]), REPO), { tone: 'working', label: 'merged' });
  assert.deepEqual(shippable(c, NOW, HUMANS, REPO, new Set()), [106]);
  assert.deepEqual(shippable(c, NOW, HUMANS, REPO, new Set([106])), [], 'shipped already');
  assert.equal(boardStatus(card('PR 98, in review'), NOW, HUMANS, new Set([98]), REPO)?.label, 'merged', 'in review, merged: not amber either');
});

test('a flight step on the orchestrator for merged PRs no longer waits on him; other steps still do', () => {
  const flights: Flight[] = [{ participant: 'claude', state: 'waiting', text: 'David: Ship it on PR 106; David: Agree on decision card #791', since: '2026-11-27T18:40:00.000Z', updated_at: '2026-11-27T18:40:00.000Z', last_message_at: null }];
  const david = { name: 'david', label: 'Orchestrator' };
  assert.equal(waitingOn(flights, david).length, 2);
  const left = waitingOn(flights, david, new Set([106]), REPO);
  assert.deepEqual(left.map((w) => w.text), ['Agree on decision card #791']);
});

test('the strip and the roadmap ask which PRs are merged; a merged PR is asked once', () => {
  const merged = readFileSync(new URL('../app/merged.ts', import.meta.url), 'utf8');
  assert.match(merged, /fetch\(`\/api\/pr\/\$\{n\}`/);
  assert.match(merged, /checked\.current\.set\(n, Infinity\)/);
  assert.match(merged, /document\.hidden\) return;/, 'not while the tab is hidden');
  const flight = readFileSync(new URL('../app/flight.tsx', import.meta.url), 'utf8');
  assert.match(flight, /const merged = useMergedPrs\(token, flights\.filter\(\(f\) => f\.state === 'waiting'\)\.map\(\(f\) => f\.text\)\);/);
  const page = readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /useMergedPrs\(token, items\.filter\(\(i\) => i\.column !== 'done'\)\.map\(\(i\) => i\.note\)\)/);
  assert.match(page, /<RoadmapBoard merged=\{merged\}/);
});
