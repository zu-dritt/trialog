// «🚀 Ship it!» on roadmap cards that are in review (playground #617): the orchestrator ships from the
// board. The go is a message to the reviewer with his 🚀 on it, the same as on any message.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { renderToStaticMarkup } from 'react-dom/server';
import { test, vi } from 'vitest';
import { shipText, shippable } from '../app/roadmap-board';
import type { RoadmapItem } from '../lib/roadmap';

const NOW = Date.parse('2026-11-27T18:00:00.000Z');
const REPO = 'zu-dritt/trialog';
const card = (note: string, over: Partial<RoadmapItem> = {}): RoadmapItem => ({
  id: 'rm_ship0000', column: 'now', position: 0, title: 'Header refresh', note, owner: 'claude', updated_by: 'claude',
  updated_at: '2026-11-27T17:50:00.000Z', progress: null, status: '', progress_at: null, description: '', attachments: [], reviewer: 'grok', raised_by: null, ...over,
});
const P = [
  { name: 'david', kind: 'human', label: 'Orchestrator', color: 'green' },
  { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' },
  { name: 'grok', kind: 'agent', label: 'Grok', color: 'orange' },
] as never;

test('which cards can be shipped: in review, or waiting on the orchestrator for a Ship it, and naming a PR', () => {
  const humans = ['david', 'Orchestrator'];
  assert.deepEqual(shippable(card('PR 98, in review'), NOW, humans, REPO), [98]);
  assert.deepEqual(shippable(card('PR 101 + PR 102, in review'), NOW, humans, REPO), [101, 102]);
  assert.deepEqual(shippable(card('⛔ WAITING ON DAVID: 🚀 Ship it on PR 103 (https://github.com/zu-dritt/trialog/pull/103)'), NOW, humans, REPO), [103]);
  assert.deepEqual(shippable(card('⛔ WAITING ON DAVID: Agree on decision card #791'), NOW, humans, REPO), [], 'a decision is not a Ship it');
  assert.deepEqual(shippable(card('building it, PR soon'), NOW, humans, REPO), [], 'working, not in review');
  assert.deepEqual(shippable(card('in review, no PR named'), NOW, humans, REPO), []);
  assert.deepEqual(shippable(card('live (PR 98)', { column: 'done' }), NOW, humans, REPO), [], 'done cards are shipped already');
  assert.equal(shipText(card(''), [101, 102]), '🚀 Ship it! PR 101, PR 102 (from the roadmap card «Header refresh»)');
});

test('the button shows for the orchestrator only, and only with a ship action', async () => {
  // The hub's repository is read at build time; this build has one.
  vi.stubEnv('TRIALOG_REPO', REPO);
  vi.resetModules();
  const { RoadmapBoard } = await import('../app/roadmap-board');
  const items = [card('PR 98, in review')];
  const ship = async () => true;
  const asDavid = renderToStaticMarkup(<RoadmapBoard items={items} participants={P} me="david" now={new Date(NOW)} actions={{ place: () => {}, ship }} />);
  assert.match(asDavid, /<button type="button" data-ship="rm_ship0000"[^>]*>🚀 Ship it! (<!-- -->)?PR 98<\/button>/);
  assert.match(asDavid, /title="Your go: posts «🚀 Ship it!» for this PR in the hub, to the reviewer\. It doesn&#x27;t merge anything itself\."/);
  const asClaude = renderToStaticMarkup(<RoadmapBoard items={items} participants={P} me="claude" now={new Date(NOW)} actions={{ place: () => {}, ship }} />);
  assert.ok(!asClaude.includes('data-ship'), 'an agent\'s 🚀 is never a go');
  const noAction = renderToStaticMarkup(<RoadmapBoard items={items} participants={P} me="david" now={new Date(NOW)} actions={{ place: () => {} }} />);
  assert.ok(!noAction.includes('data-ship'));
  vi.unstubAllEnvs();
});

test('the page posts the go to the reviewer and puts the 🚀 on it', () => {
  const page = readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /api\('\/api\/messages', \{ method: 'POST', body: JSON\.stringify\(\{ text: shipText\(card, prs\), \.\.\.\(card\.reviewer \? \{ to: card\.reviewer \} : \{\}\) \}\) \}\)/);
  assert.match(page, /api\(`\/api\/messages\/\$\{message\.id\}\/reactions\/\$\{encodeURIComponent\('🚀'\)\}`, \{ method: 'PUT' \}\)/);
  assert.match(page, /addIdea, upload, ship, build \}\}/);
});

test('a second click while the go is on its way posts nothing (Grok\'s nit on PR 106)', () => {
  const board = readFileSync(new URL('../app/roadmap-board.tsx', import.meta.url), 'utf8');
  assert.match(board, /disabled=\{busy \|\| sending\.has\(card\.id\)\}/);
  assert.match(board, /if \(sending\.has\(card\.id\)\) return;\s+setSending/);
});
