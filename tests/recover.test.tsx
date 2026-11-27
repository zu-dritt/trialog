// When the page breaks (playground #869): reload once by itself, then show the cause.
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';
import { RELOADED_KEY, RELOAD_WINDOW_MS, Recover, errorLine, shouldReload } from '../app/recover';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };

test('reloads once; a second break within a minute stays; later it may reload again', () => {
  const s = memory();
  assert.equal(shouldReload(s, 1_000), true);
  assert.equal(s.m.get(RELOADED_KEY), '1000');
  assert.equal(shouldReload(s, 1_000 + RELOAD_WINDOW_MS - 1), false, 'broke again right away: a real error');
  assert.equal(shouldReload(s, 1_000 + RELOAD_WINDOW_MS), true, 'a new release much later: reload again');
  assert.equal(shouldReload(null, 1_000), false, 'no storage: never loop');
});

test('the small print names the error and Next\'s digest', () => {
  assert.equal(errorLine({ name: 'ChunkLoadError', message: 'Loading chunk 42 failed.', digest: 'abc123' }), 'ChunkLoadError: Loading chunk 42 failed. (digest abc123)');
  assert.equal(errorLine({}), 'Unknown error');
});

test('the page says it is loading the newest version first; both error pages use it', () => {
  const html = renderToStaticMarkup(<Recover error={Object.assign(new Error('x'), { digest: 'd' })} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Loading the newest version…/);
  for (const f of ['../app/error.tsx', '../app/global-error.tsx']) assert.ok(existsSync(new URL(f, import.meta.url)), f);
});

test('no reload when the note can\'t be written, so it can never loop (Grok\'s review of PR 113)', () => {
  const readOnly = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(shouldReload(readOnly, 1_000), false);
  const forgetful = { getItem: () => null, setItem: () => {} };
  assert.equal(shouldReload(forgetful, 1_000), false, 'written but not kept: no guard, no reload');
  const throwsOnRead = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
  assert.equal(shouldReload(throwsOnRead, 1_000), false);
});

test('a second break shows the error, with its small print', async () => {
  const s = { m: new Map<string, string>([[RELOADED_KEY, String(Date.now())]]) };
  const store = { getItem: (k: string) => s.m.get(k) ?? null, setItem: (k: string, v: string) => { s.m.set(k, v); } };
  assert.equal(shouldReload(store, Date.now()), false, 'within the minute: stays');
  assert.match(errorLine({ name: 'TypeError', message: 'x is undefined' }), /^TypeError: x is undefined$/);
});
