// The demo hub: public tokens, a banner, one-click sign-in, and never a database.
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEMO_PARTICIPANTS, isDemo } from '../lib/demo';
import { DEMO_BANNER, DemoBanner, DemoSignIn } from '../app/demo';
import { MIN_TOKEN_LENGTH } from '../lib/participants';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; delete (globalThis as { __collabHubStore?: unknown }).__collabHubStore; });

test('demo mode is only TRIALOG_DEMO=1', () => {
  assert.equal(isDemo({ TRIALOG_DEMO: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(isDemo({ TRIALOG_DEMO: v }), false, String(v));
});

test('the public tokens are usable, distinct, and the same as in docs/demo.md', () => {
  const docs = readFileSync(new URL('../docs/demo.md', import.meta.url), 'utf8');
  const tokens = DEMO_PARTICIPANTS.map((p) => p.token);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const p of DEMO_PARTICIPANTS) {
    assert.ok(p.token.length >= MIN_TOKEN_LENGTH, p.name);
    assert.ok(p.token.startsWith('demo-'), 'a demo token says what it is');
    assert.ok(docs.includes(`${p.name.toUpperCase()}_TOKEN=${p.token}`), `${p.name} is documented`);
  }
});

test('the banner and the sign-in buttons', () => {
  assert.match(renderToStaticMarkup(<DemoBanner />), new RegExp(DEMO_BANNER.slice(0, 20)));
  const html = renderToStaticMarkup(<DemoSignIn onPick={() => {}} />);
  for (const p of DEMO_PARTICIPANTS) assert.match(html, new RegExp(`Sign in as ${p.label}`));
});

test('a demo hub refuses to start with a database', async () => {
  process.env.TRIALOG_DEMO = '1';
  process.env.DATABASE_URL = 'postgres://example.invalid/db';
  const { getStore } = await import('../lib/store');
  await assert.rejects(getStore(), /TRIALOG_DEMO is set together with DATABASE_URL/);
});

test('the build writes TRIALOG_DEMO into the page, so the banner and buttons can show', () => {
  // Found in review: without this, the page never knows it is the demo.
  const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
  assert.match(config, /TRIALOG_DEMO: process\.env\.TRIALOG_DEMO === '1' \? '1' : ''/);
});
