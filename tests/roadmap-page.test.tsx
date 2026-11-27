// The roadmap page: where a card lands, the board as it renders, and the way to it from the hub.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoadmapBoard, columnOf, placeAt } from '../app/roadmap-board';
import type { RoadmapItem } from '../lib/roadmap';

const card = (id: string, column: RoadmapItem['column'], position: number, over: Partial<RoadmapItem> = {}): RoadmapItem =>
  ({ id, column, position, title: `T ${id}`, note: '', owner: null, updated_by: 'claude', updated_at: '2026-11-27T08:00:00.000Z', ...over });

test('a card lands where it is put, from its own column or another', () => {
  assert.deepEqual(placeAt(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(placeAt(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(placeAt(['a', 'b'], 'x', 1), ['a', 'x', 'b'], 'from another column');
  assert.deepEqual(placeAt(['a', 'b'], 'x', 99), ['a', 'b', 'x'], 'past the end: at the end');
  assert.deepEqual(placeAt(['a', 'b'], 'b', -1), ['b', 'a'], 'before the start: first');
});

test('a column lists its cards by position', () => {
  const items = [card('b', 'next', 1), card('a', 'next', 0), card('d', 'done', 0)];
  assert.deepEqual(columnOf(items, 'next').map((i) => i.id), ['a', 'b']);
});

test('the board: four columns, numbered cards, owners, and the controls only when it can change', () => {
  const items = [card('rm_aaaaaaaa', 'next', 0, { title: 'Deploy button', owner: 'grok', note: 'one click' }), card('rm_bbbbbbbb', 'next', 1, { title: 'Hovercard' })];
  const view = renderToStaticMarkup(<RoadmapBoard items={items} />);
  assert.deepEqual([...view.matchAll(/data-column="([a-z]+)"/g)].map((m) => m[1]), ['done', 'now', 'next', 'later']);
  assert.match(view, /Deploy button<\/div><div class="mt-0\.5 text-xs text-muted"><span class="font-semibold"[^>]*>Grok<\/span> · one click/);
  assert.ok(!view.includes('↑') && !view.includes('draggable="true"'), 'read-only without actions');
  const live = renderToStaticMarkup(<RoadmapBoard items={items} actions={{ place: () => {} }} />);
  assert.equal(live.match(/draggable="true"/g)?.length, 2);
  const button = (label: string) => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(live)?.[0] ?? '';
  assert.match(button('Move «Deploy button» up'), /disabled=""/, 'the first card cannot go up');
  assert.match(button('Move «Hovercard» down'), /disabled=""/, 'the last card cannot go down');
  assert.doesNotMatch(button('Move «Hovercard» up'), /disabled=""/);
  assert.match(live, /<span class="sr-only">Column of «Hovercard»<\/span><select/);
});

test('the hub links the roadmap in the header and in the «⋯» menu, in a tab of its own', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /href="\/roadmap" target="trialog-roadmap"/);
  assert.match(page, /\{ label: 'Roadmap', href: '\/roadmap', target: 'trialog-roadmap' \}/);
});

test('a card with no owner offers «Claim»; your own offers «Release»; done cards neither', () => {
  const items = [card('rm_cccccccc', 'next', 0), card('rm_dddddddd', 'next', 1, { owner: 'claude' }), card('rm_eeeeeeee', 'next', 2, { owner: 'grok' }), card('rm_ffffffff', 'done', 0)];
  const html = renderToStaticMarkup(<RoadmapBoard items={items} me="claude" actions={{ place: () => {}, claim: () => {} }} />);
  assert.deepEqual([...html.matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]), ['rm_cccccccc']);
  assert.deepEqual([...html.matchAll(/data-release="([^"]+)"/g)].map((m) => m[1]), ['rm_dddddddd']);
  assert.ok(!renderToStaticMarkup(<RoadmapBoard items={items} actions={{ place: () => {}, claim: () => {} }} />).includes('data-claim'), 'no claim without knowing who you are');
});

test('the roadmap tab is named «Trialog Roadmap»', async () => {
  const { metadata } = await import('../app/roadmap/layout');
  assert.equal(metadata.title, 'Trialog Roadmap');
  assert.match(readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8'), /document\.title = 'Trialog Roadmap'/);
});

test('«+ Idee» sits at the top of Later when the page can add, and nowhere else', () => {
  const html = renderToStaticMarkup(<RoadmapBoard items={[]} actions={{ place: () => {}, addIdea: async () => true }} />);
  assert.equal(html.match(/data-idea-box=""/g)?.length, 1);
  assert.match(html, /data-column="later"[^]*data-idea-box=""/);
  assert.match(html, /aria-label="Add an idea to Later \(no message, wakes no one\)"/);
  assert.ok(!renderToStaticMarkup(<RoadmapBoard items={[]} actions={{ place: () => {} }} />).includes('data-idea-box'));
  const page = readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /column: 'later', title, note: `💡 idea from \$\{who\}`/);
});
