// The streak in the Guard panel: the numbers, the way to a record, the timeline and the reasons.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreakChart, StreakView, streakPaths, toRecord } from '../app/streak';
import { computeStreak, type StreakReport } from '../lib/streak';

const at = (h: number) => new Date(Date.UTC(2026, 10, 27, h)).toISOString();
const report = (): StreakReport => ({
  repo: 'o/r', base: 'playground', problem: null,
  ...computeStreak(
    [1, 2, 3, 5, 6].map((h, i) => ({ number: i + 1, title: '', merged_at: at(h) })),
    [{ id: 1, participant: 'claude', reason: 'needed a Vercel setting', created_at: at(4) }],
  ),
});

test('the way to the record reads in words', () => {
  assert.equal(toRecord(2, 3), '1 more for a new record');
  assert.equal(toRecord(4, 4), 'a new record! 🏆');
  assert.equal(toRecord(0, 0), '');
});

test('the timeline: the streak as steps, the record only climbing, a red dot at each break', () => {
  const { streak, record, breaks, max } = streakPaths(report().points);
  assert.equal(max, 3);
  assert.match(streak, /^M4\.0,76\.0 /, 'starts at zero on the left');
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].point.break?.ended, 3);
  // The record never goes down: its V steps only move up the chart (smaller y).
  const ys = [...record.matchAll(/V([\d.]+)/g)].map((m) => Number(m[1]));
  assert.deepEqual([...ys].sort((a, b) => b - a), ys);
  assert.deepEqual(streakPaths([]), { streak: '', record: '', breaks: [], max: 0 });
});

test('the view shows now, the record, the chart and where the last streak ended', () => {
  const html = renderToStaticMarkup(<StreakView report={report()} />);
  assert.match(html, /data-streak="current">2</);
  assert.match(html, /data-streak="record">3</);
  assert.match(html, /1 more for a new record/);
  assert.match(html, /<li[^>]*><span class="font-semibold">3<\/span> → needed a Vercel setting/);
  assert.match(html, /<svg[^>]*role="img"/);
  assert.ok(!html.includes('I stepped in'), 'no button without a way to send');
  assert.match(renderToStaticMarkup(<StreakView report={report()} onBreak={async () => true} />), /I stepped in…/);
  assert.equal(renderToStaticMarkup(<StreakChart report={{ points: [] }} />), '');
});

test('a problem reading GitHub is said, not hidden', () => {
  assert.match(renderToStaticMarkup(<StreakView report={{ ...report(), problem: 'Could not read merges from GitHub (GitHub answered 403).' }} />), /GitHub answered 403/);
});

test('the Guard panel holds the streak section', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/guard.tsx', import.meta.url), 'utf8');
  assert.match(src, /<StreakSection api=\{api\} participants=\{participants\} \/>/);
});
