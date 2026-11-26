// Component rendering and client polling checks for the "Thinking…" status bar.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusList, activeStatuses, fetchStatuses } from '../app/status';
import { NEUTRAL_COLOR, PARTICIPANT_COLORS, type Participant, type ParticipantStatus } from '../lib/shared';

const BASE_NOW = Date.parse('2026-11-26T04:06:00.000Z');
// What GET /api/participants returns for the default three.
const THREE: Participant[] = [{ name: 'grok', kind: 'agent', color: 0 }, { name: 'claude', kind: 'agent', color: 1 }, { name: 'david', kind: 'human', color: 2 }];
const sample: ParticipantStatus[] = [
  { participant: 'grok', text: 'reviewing pull request 7', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:05:00.000Z' },
  { participant: 'claude', text: '<script>alert(1)</script> polishing UI', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:04:00.000Z' },
];

test('StatusList renders nothing when there are no active statuses', () => {
  assert.equal(renderToStaticMarkup(<StatusList statuses={[]} now={BASE_NOW} />), '');
});

test('StatusList renders participant colours, animated dots, and escapes HTML', () => {
  const out = renderToStaticMarkup(<StatusList statuses={sample} now={BASE_NOW} participants={THREE} />);
  assert.match(out, /role="status"/);
  assert.match(out, /aria-live="polite"/);
  assert.ok(out.includes(`color:${PARTICIPANT_COLORS[0]}`), "Grok's colour");
  assert.ok(out.includes(`color:${PARTICIPANT_COLORS[1]}`), "Claude's colour");
  assert.match(out, /Grok:/);
  assert.match(out, /reviewing pull request 7/);
  assert.match(out, /status-dot/);
  assert.ok(!out.includes('<script'), 'HTML in status text must be escaped');
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('StatusList shows any configured participant in their colour, and a former one in the neutral colour', () => {
  const four: Participant[] = [{ name: 'ana', kind: 'human', color: 0 }, { name: 'quill-2', kind: 'agent', color: 3 }];
  const statuses: ParticipantStatus[] = [
    { participant: 'quill-2', text: 'running the tests', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:05:00.000Z' },
    { participant: 'gone', text: 'left a status behind', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:04:00.000Z' },
  ];
  const out = renderToStaticMarkup(<StatusList statuses={statuses} now={BASE_NOW} participants={four} />);
  assert.match(out, /Quill-2:/);
  assert.ok(out.includes(`color:${PARTICIPANT_COLORS[3]}`));
  assert.match(out, /Gone:/);
  assert.ok(out.includes(`color:${NEUTRAL_COLOR}`));
  // Before the list has arrived, everyone is neutral and nothing breaks.
  assert.ok(renderToStaticMarkup(<StatusList statuses={statuses} now={BASE_NOW} />).includes(`color:${NEUTRAL_COLOR}`));
});

test('activeStatuses and StatusList hide statuses once expires_at has passed', () => {
  const mixed: ParticipantStatus[] = [
    { participant: 'grok', text: 'already expired', expires_at: '2026-11-26T04:06:00.000Z', updated_at: '2026-11-26T04:01:00.000Z' },
    { participant: 'claude', text: 'still working', expires_at: '2026-11-26T04:08:00.000Z', updated_at: '2026-11-26T04:05:00.000Z' },
    { participant: 'david', text: 'bad timestamp', expires_at: 'not-a-date', updated_at: '2026-11-26T04:05:00.000Z' },
  ];
  assert.deepEqual(activeStatuses(mixed, BASE_NOW).map((s) => s.participant), ['claude']);

  const partial = renderToStaticMarkup(<StatusList statuses={mixed} now={BASE_NOW} />);
  assert.ok(!partial.includes('already expired'));
  assert.ok(!partial.includes('bad timestamp'));
  assert.match(partial, /still working/);

  // Once the remaining status passes its expires_at, StatusList renders nothing.
  const allExpired = renderToStaticMarkup(<StatusList statuses={mixed} now={Date.parse('2026-11-26T04:08:00.000Z')} />);
  assert.equal(allExpired, '');
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
