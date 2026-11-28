// The guard on the page, as far as it can be checked without a browser: the ring's colour and
// label, where the chart's bars go, and the markup of the ring, chart and panel. How it looks next
// to the composer, the popover's place and Escape need a browser and are checked by hand.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHART, GuardChart, GuardFigure, GuardPanel, GuardRing, RING_COLORS, barTitle, chartLayout, ringLabel, ringLevel, share } from '../app/guard';
import { ComposerTools } from '../app/composer';
import { GUARD_DEFAULTS, type GuardReport } from '../lib/guard';
import { PARTICIPANT_COLORS } from '../lib/shared';
import { parseParticipants } from '../lib/participants';

const ROSTER = parseParticipants('ana:human,scout:agent,quill:agent:Quill Bot');
const start = Date.parse('2026-11-25T13:00:00Z');
function report(over: Partial<GuardReport> = {}, counts: Record<number, Record<string, number>> = {}): GuardReport {
  return {
    limits: GUARD_DEFAULTS,
    now: { hour: 5, inARow: 3, day: 177 },
    tripped: null,
    hours: Array.from({ length: 24 }, (_, i) => ({ start: new Date(start + i * 3_600_000).toISOString(), bySender: { scout: 0, quill: 0, ...counts[i] } })),
    pausesToday: 2,
    ...over,
  };
}

test('the ring: green, amber from 80% of the day, red when tripped, and what it says', () => {
  assert.equal(ringLevel(report()), 'ok');
  assert.equal(ringLevel(report({ now: { hour: 0, inARow: 0, day: 239 } })), 'ok');
  assert.equal(ringLevel(report({ now: { hour: 0, inARow: 0, day: 240 } })), 'warn');
  assert.equal(ringLevel(report({ tripped: 'in-a-row' })), 'tripped');
  assert.equal(ringLabel(report()), 'Agent messages today: 177 of 300 (59%)');
  assert.equal(ringLabel(report({ tripped: 'in-a-row' })), 'Agent messages today: 177 of 300 (59%). Wake-ups paused: 12 agent messages in a row without a human.');
  assert.equal(share(450, 300), 1);
  assert.equal(share(-1, 300), 0);

  const html = renderToStaticMarkup(<GuardRing report={report({ tripped: 'day' })} open={false} onToggle={() => {}} />);
  assert.match(html, /<button type="button"[^>]*aria-label="Agent messages today: 177 of 300 \(59%\)\. Wake-ups paused/);
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
  assert.ok(html.includes(`stroke="${RING_COLORS.tripped}"`));
});

test('the chart: stacked by agent in roster order and colour, scaled to at least the hourly limit', () => {
  const r = report({}, { 3: { scout: 6, quill: 3 }, 23: { quill: 1 } });
  const layout = chartLayout(r, ROSTER);
  assert.equal(layout.bars.length, 24);
  assert.equal(layout.scale, 60, 'the limit decides the scale while every hour is under it');
  assert.equal(layout.limitY, CHART.top);
  const bar = layout.bars[3];
  assert.equal(bar.total, 9);
  assert.deepEqual(bar.segments.map((s) => [s.name, s.count, s.color]), [['scout', 6, PARTICIPANT_COLORS[1]], ['quill', 3, PARTICIPANT_COLORS[2]]]);
  assert.ok(bar.segments[0].y + bar.segments[0].height <= layout.baseline + 0.001, 'the first agent sits on the baseline');
  assert.ok(bar.segments[1].y + bar.segments[1].height < bar.segments[0].y, 'a gap between two agents');
  assert.deepEqual(layout.bars[5].segments, [], 'an empty hour has no parts');
  assert.ok(layout.bars.every((b, i) => i === 0 || b.x > layout.bars[i - 1].x), 'oldest at the left');

  // One hour over the limit: the scale grows and the limit line moves down.
  const over = chartLayout(report({}, { 10: { scout: 90, quill: 30 } }), ROSTER);
  assert.equal(over.scale, 120);
  assert.ok(over.limitY > CHART.top);

  assert.match(barTitle(bar, ROSTER), /: Scout 6, Quill Bot 3$/);
  assert.match(barTitle(layout.bars[5], ROSTER), /: no agent messages$/);

  const html = renderToStaticMarkup(<GuardChart report={r} participants={ROSTER} />);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Agent messages per hour, the last 24 hours\. The busiest hour had 9; the limit is 60 an hour\."/);
  assert.match(html, /stroke="#f85149"[^>]*stroke-dasharray="4 3"/, 'the dashed red limit line');
  assert.ok(html.includes(`fill="${PARTICIPANT_COLORS[1]}"`) && html.includes(`fill="${PARTICIPANT_COLORS[2]}"`));
  assert.match(html, />Quill Bot</, 'the legend names the agents by their labels');
  assert.ok(!html.includes('http'), 'nothing loaded from elsewhere');
});

test('the panel: what holds wake-ups back, the chart and three figures', () => {
  const html = renderToStaticMarkup(<GuardPanel report={report({ tripped: 'in-a-row', now: { hour: 12, inARow: 12, day: 177 } })} error="" participants={ROSTER} onClose={() => {}} />);
  assert.match(html, /role="dialog" aria-label="Guard"/);
  assert.match(html, /Wake-ups paused<\/span>: 12 agent messages in a row without a human\. Write anything to continue\./);
  assert.match(html, /Agent messages, last 24 hours<\/span><span[^>]*>177 \/ 300 <span[^>]*>59%<\/span></);
  assert.match(html, /In a row without a human<\/span><span[^>]*>12 \/ 12 <span[^>]*>100%<\/span></);
  assert.match(html, /Pauses, last 24 hours<\/span><span[^>]*>2</);
  assert.match(html, /aria-label="Close the Guard panel"/);

  const free = renderToStaticMarkup(<GuardPanel report={report()} error="" participants={ROSTER} onClose={() => {}} />);
  assert.match(free, /Wake-ups go out\./);
  assert.match(renderToStaticMarkup(<GuardPanel report={null} error="HTTP 500" participants={ROSTER} onClose={() => {}} />), /role="alert">HTTP 500</);

  const figure = renderToStaticMarkup(<GuardFigure label="x" value={250} of={300} />);
  assert.ok(figure.includes('width:83%') && figure.includes(RING_COLORS.warn));
});

test('the composer row has a place for the ring, after the size button and before Send', () => {
  const props = {
    to: '', onTo: () => {}, recipients: [],
    emoji: { open: false, onOpenChange: () => {}, onInsert: () => {}, boxRef: { current: null } },
    image: { disabled: false, onPick: () => {} },
    decision: { open: false, onToggle: () => {} },
    poll: { open: false, onToggle: () => {} },
    expand: { expanded: false, onToggle: () => {} },
    send: { disabled: false, label: 'Send' },
    fieldClassName: '', toolClassName: '',
  };
  const html = renderToStaticMarkup(<ComposerTools {...props} guard={<GuardRing report={report()} open={false} onToggle={() => {}} />} />);
  const ring = html.indexOf('Agent messages today');
  assert.ok(ring > html.indexOf('Enlarge the message box') && ring < html.indexOf('>Send<'));
  assert.ok(!renderToStaticMarkup(<ComposerTools {...props} />).includes('Agent messages today'), 'none without a guard (the second pane)');
});

test('the figures and the ring say how full, in percent, rounded down', async () => {
  const { percent } = await import('../app/guard');
  assert.equal(percent(241, 300), 80);
  assert.equal(percent(299, 300), 99, 'only a reached limit reads 100%');
  assert.equal(percent(300, 300), 100);
  assert.equal(percent(0, 300), 0);
  assert.match(renderToStaticMarkup(<GuardFigure label="x" value={219} of={300} />), />73%</);
  assert.ok(!renderToStaticMarkup(<GuardFigure label="Pauses" value={2} />).includes('%'), 'no percent without a limit');
});
