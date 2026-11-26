// Component rendering and client polling checks for the "Thinking…" status bar.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusList, fetchStatuses } from '../app/status';
import type { ParticipantStatus } from '../lib/shared';

const sample: ParticipantStatus[] = [
  { participant: 'grok', text: 'reviewing pull request 7', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:05:00.000Z' },
  { participant: 'claude', text: '<script>alert(1)</script> polishing UI', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:04:00.000Z' },
];

test('StatusList renders nothing when there are no active statuses', () => {
  assert.equal(renderToStaticMarkup(<StatusList statuses={[]} />), '');
});

test('StatusList renders participant colours, animated dots, and escapes HTML', () => {
  const out = renderToStaticMarkup(<StatusList statuses={sample} />);
  assert.match(out, /role="status"/);
  assert.match(out, /aria-live="polite"/);
  assert.match(out, /text-grok/);
  assert.match(out, /text-claude/);
  assert.match(out, /Grok:/);
  assert.match(out, /reviewing pull request 7/);
  assert.match(out, /status-dot/);
  assert.ok(!out.includes('<script'), 'HTML in status text must be escaped');
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test('globals.css disables dot animation under prefers-reduced-motion', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.status-dot[\s\S]*animation:\s*none/);
});

test('fetchStatuses sends Bearer token and calls onUnauthorized only on 401', async () => {
  let forgotten = 0;
  const calls: { url: string; auth: string | null }[] = [];
  const mkFetch = (status: number, body: unknown) => (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const ok = await fetchStatuses('my-token', () => { forgotten += 1; }, mkFetch(200, { statuses: sample }));
  assert.equal(ok?.length, 2);
  assert.equal(forgotten, 0);
  assert.deepEqual(calls[0], { url: '/api/status', auth: 'Bearer my-token' });

  const err500 = await fetchStatuses('my-token', () => { forgotten += 1; }, mkFetch(500, { error: 'down' }));
  assert.equal(err500, null);
  assert.equal(forgotten, 0);

  const err401 = await fetchStatuses('bad-token', () => { forgotten += 1; }, mkFetch(401, { error: 'unauthorized' }));
  assert.equal(err401, null);
  assert.equal(forgotten, 1);
});
