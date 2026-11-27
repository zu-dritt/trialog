// Grok's review notes on PR 66–74 (playground #513), one test each.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

test('PR 66: the Guard bar and its percent use the same rounding', async () => {
  const { GuardFigure } = await import('../app/guard');
  // 299 / 300 = 99.67%: Math.round would draw 100% next to the label «99%».
  const html = renderToStaticMarkup(<GuardFigure label="x" value={299} of={300} />);
  assert.match(html, />99%</);
  assert.match(html, /width:99%/);
});

test('PR 68: an optional GitHub token goes along, and a limit says how to raise it', async () => {
  const { githubHeaders, fetchMerges } = await import('../lib/streak');
  assert.equal(githubHeaders({}).Authorization, undefined);
  assert.equal(githubHeaders({ TRIALOG_GITHUB_TOKEN: ' abc ' }).Authorization, 'Bearer abc');
  for (const status of [403, 429]) {
    const limited = (async () => new Response('{}', { status })) as unknown as typeof fetch;
    await assert.rejects(fetchMerges('o/r', 'playground', limited, {}), /hourly limit is reached.*TRIALOG_GITHUB_TOKEN/);
  }
});

test('PR 70: near the top of the scrolling area the hovercard opens below the link', async () => {
  const { cardBelow, CARD_ROOM_PX } = await import('../app/markdown');
  assert.equal(cardBelow(100, 100), true, 'the first line');
  assert.equal(cardBelow(100 + CARD_ROOM_PX - 1, 100), true);
  assert.equal(cardBelow(100 + CARD_ROOM_PX, 100), false);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8'), /\.hovercard\[data-below="1"\]::after \{ bottom: auto; top: calc\(100% \+ 6px\); \}/);
});

test('PR 71: a blocked pop-up is said, and the view stays open', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/attachments.tsx', import.meta.url), 'utf8');
  assert.match(src, /if \(popOut\(\{ url: viewed\.url, size \}\)\) onClose\(\); else setBlocked\(true\);/);
  assert.match(src, /Pop-up blocked: allow pop-ups for this site, then try again\./);
});

test('PR 73: the phone menu opens the roadmap in the same named tab as the header link', async () => {
  const { MoreMenu } = await import('../app/more-menu');
  const html = renderToStaticMarkup(<MoreMenu items={[{ label: 'Roadmap', href: '/roadmap', target: 'trialog-roadmap' }, { label: 'Demo hub', href: 'https://demo.example/' }]} initiallyOpen />);
  assert.match(html, /href="\/roadmap" target="trialog-roadmap"/);
  assert.match(html, /href="https:\/\/demo\.example\/" target="_blank"/, 'other links still open a new tab');
});

test('PR 74: the version chime wins a tie with an addressed note, and the reminder really comes after 30 minutes', async () => {
  const { versionChimes, VERSION_REMINDER_MS } = await import('../app/sound');
  vi.useFakeTimers();
  try {
    const heard: string[] = [];
    const cancel = versionChimes((cue) => heard.push(cue.kind), { set: setTimeout, clear: clearTimeout });
    assert.deepEqual(heard, ['version']);
    vi.advanceTimersByTime(VERSION_REMINDER_MS - 1);
    assert.deepEqual(heard, ['version']);
    vi.advanceTimersByTime(1);
    assert.deepEqual(heard, ['version', 'version'], 'the second chime');
    const quiet: string[] = [];
    versionChimes((cue) => quiet.push(cue.kind), { set: setTimeout, clear: clearTimeout })();
    vi.advanceTimersByTime(VERSION_REMINDER_MS);
    assert.deepEqual(quiet, ['version'], 'reloading (cancel) stops the reminder');
    cancel();
  } finally {
    vi.useRealTimers();
  }
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../app/sound.tsx', import.meta.url), 'utf8'), /version: 3\.5/);
});
