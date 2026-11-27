// A hidden tab's stream naps after 15 minutes, so the database can sleep (playground #761, go #762).
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { NAP_AFTER_MS, eitherSignal, watchNap } from '../app/nap';

function fakeTab(hidden: boolean) {
  const listeners = new Set<() => void>();
  let pending: { f: () => void; at: number } | null = null;
  let now = 0;
  const doc = {
    hidden,
    addEventListener: (_: 'visibilitychange', l: () => void) => { listeners.add(l); },
    removeEventListener: (_: 'visibilitychange', l: () => void) => { listeners.delete(l); },
  };
  return {
    doc,
    listeners,
    show(h: boolean) { doc.hidden = h; for (const l of listeners) l(); },
    advance(ms: number) { now += ms; if (pending && pending.at <= now) { const p = pending; pending = null; p.f(); } },
    timers: {
      setTimer: (f: () => void, ms: number) => { pending = { f, at: now + ms }; return pending; },
      clearTimer: (t: unknown) => { if (pending === t) pending = null; },
    },
  };
}

test('naps after 15 minutes hidden, not before', () => {
  assert.equal(NAP_AFTER_MS, 15 * 60_000);
  const tab = fakeTab(false);
  let naps = 0;
  const nap = watchNap(tab.doc, () => { naps++; }, tab.timers);
  tab.show(true);
  tab.advance(NAP_AFTER_MS - 1);
  assert.equal(nap.napping, false);
  assert.equal(naps, 0);
  tab.advance(1);
  assert.equal(nap.napping, true);
  assert.equal(naps, 1, 'the open stream is ended once');
});

test('a short look at another tab changes nothing', () => {
  const tab = fakeTab(false);
  let naps = 0;
  const nap = watchNap(tab.doc, () => { naps++; }, tab.timers);
  tab.show(true);
  tab.advance(10 * 60_000);
  tab.show(false);
  tab.show(true);
  tab.advance(10 * 60_000);
  assert.equal(nap.napping, false, 'the 15 minutes start again');
  assert.equal(naps, 0);
});

test('shown again, it wakes at once and the waiting stream goes on', async () => {
  const tab = fakeTab(true);
  const nap = watchNap(tab.doc, () => {}, tab.timers);
  tab.advance(NAP_AFTER_MS);
  let woke = false;
  const waiting = nap.awake().then(() => { woke = true; });
  await Promise.resolve();
  assert.equal(woke, false);
  tab.show(false);
  await waiting;
  assert.equal(woke, true);
  assert.equal(nap.napping, false);
});

test('a tab opened in the background naps too; leaving the page stops waiting and listening', async () => {
  const tab = fakeTab(true);
  const nap = watchNap(tab.doc, () => {}, tab.timers);
  tab.advance(NAP_AFTER_MS);
  assert.equal(nap.napping, true);
  const abort = new AbortController();
  const waiting = nap.awake(abort.signal);
  abort.abort();
  await waiting;
  nap.stop();
  assert.equal(tab.listeners.size, 0);
});

test('the pane ends its stream on a nap and skips the poll fallback while napping', () => {
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /const nap = watchNap\(document, \(\) => conn\.abort\(\)\);/);
  assert.match(pane, /signal: eitherSignal\(abort\.signal, conn\.signal\)/);
  assert.match(pane, /if \(nap\.napping\) \{\s+if \(lead\) setStatus\?\.\('live · napping while hidden'\);\s+await nap\.awake\(abort\.signal\);/);
  assert.match(pane, /while \(!stopped && !nap\.napping && Date\.now\(\) < until\)/);
  assert.match(pane, /nap\.stop\(\);/);
  const guard = readFileSync(new URL('../app/guard.tsx', import.meta.url), 'utf8');
  assert.match(guard, /if \(!document\.hidden\) void load\(\); \}, open \? GUARD_PANEL_MS : GUARD_RING_MS/);
});

test('eitherSignal aborts when either signal does, also in browsers without AbortSignal.any', () => {
  const a = new AbortController(); const b = new AbortController();
  const both = eitherSignal(a.signal, b.signal);
  assert.equal(both.aborted, false);
  b.abort();
  assert.equal(both.aborted, true);
  const c = new AbortController(); c.abort();
  assert.equal(eitherSignal(c.signal, new AbortController().signal).aborted, true, 'already aborted');
});

test('waiting for the tab leaves no abort listener behind once the tab is shown', async () => {
  const tab = fakeTab(true);
  const nap = watchNap(tab.doc, () => {}, tab.timers);
  tab.advance(NAP_AFTER_MS);
  const abort = new AbortController();
  let removed = 0;
  const remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removed++; return remove(...args); };
  const waiting = nap.awake(abort.signal);
  tab.show(false);
  await waiting;
  assert.equal(removed, 1);
});
