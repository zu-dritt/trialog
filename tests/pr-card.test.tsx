// PR hovercards (playground #603): what the summary keeps, where a picture may come from, which links
// get a card, and what the card shows.
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearPrCache, pictureOf, prSummary, snippetOf, summarize } from '../lib/pr-summary';
import { PrCardView, prNumberOf } from '../app/pr-card';

test('the snippet is plain text: no images, links as their words, no Markdown marks, cut with …', () => {
  assert.equal(snippetOf('![pic](https://x/y.png)\n\n**What:** a [link](https://e.x) and `code`'), 'What: a link and code');
  assert.match(snippetOf('word '.repeat(100), 40), /…$/);
  assert.ok(snippetOf('word '.repeat(100), 40).length <= 40);
});

test('a picture only from our own hosts', () => {
  assert.equal(pictureOf('![a](https://raw.githubusercontent.com/zu-dritt/trialog/pr-media/pr/84/idea.png)'), 'https://raw.githubusercontent.com/zu-dritt/trialog/pr-media/pr/84/idea.png');
  assert.equal(pictureOf('<img src="https://github.com/a/b/blob/x.png?raw=true" width="300">'), 'https://github.com/a/b/blob/x.png?raw=true');
  assert.equal(pictureOf('![a](https://tracker.example/pixel.png)'), null, 'any other host is not fetched');
  assert.equal(pictureOf('no picture'), null);
});

test('state: merged beats closed; open is open', () => {
  assert.equal(summarize({ number: 1, state: 'closed', merged_at: '2026-11-27T00:00:00Z' }).summary.state, 'merged');
  assert.equal(summarize({ number: 1, state: 'closed', merged_at: null }).summary.state, 'closed');
  assert.equal(summarize({ number: 1, state: 'open', user: { login: 'zu-zweit' }, title: 'T', body: '![p](https://raw.githubusercontent.com/a.png) hi' }).summary.author, 'zu-zweit');
});

beforeEach(() => clearPrCache());

test('GitHub is asked once per five minutes; a missing PR is null', async () => {
  let asked = 0;
  const ok = (async () => { asked++; return new Response(JSON.stringify({ number: 84, title: 'Idea box', state: 'open', body: 'x', user: { login: 'zu-zweit' }, html_url: 'u' })); }) as unknown as typeof fetch;
  const t = Date.parse('2026-11-27T10:00:00Z');
  assert.equal((await prSummary('o/r', 84, t, ok))?.summary.title, 'Idea box');
  await prSummary('o/r', 84, t + 60_000, ok);
  assert.equal(asked, 1);
  const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  assert.equal(await prSummary('o/r', 999, t, missing), null);
});

test('only links to a pull request of this hub\'s repository get a card', () => {
  assert.equal(prNumberOf('https://github.com/zu-dritt/trialog/pull/84', 'zu-dritt/trialog'), 84);
  assert.equal(prNumberOf('https://github.com/amberleaf-gmbh/apartment-finder/pull/36', 'zu-dritt/trialog'), null, 'another repo: a plain link');
  assert.equal(prNumberOf('https://github.com/zu-dritt/trialog/issues/5', 'zu-dritt/trialog'), null);
  assert.equal(prNumberOf('https://github.com/zu-dritt/trialog/pull/84', null), null);
});

test('the card shows number, author, title, state, picture and the first lines', () => {
  const html = renderToStaticMarkup(<PrCardView picture="blob:x" summary={{ number: 84, title: 'Roadmap: «+ Idee»', state: 'merged', author: 'zu-zweit', snippet: 'What: a box…', hasPicture: true, url: 'u' }} />);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /zu-dritt · PR 84 · zu-zweit/);
  assert.match(html, /Roadmap: «\+ Idee»/);
  assert.match(html, />Merged</);
  assert.match(html, /<img src="blob:x"/);
  assert.match(html, /What: a box…/);
});

test('a missing PR or a GitHub failure is remembered for a minute, then asked again', async () => {
  let asked = 0;
  const missing = (async () => { asked++; return new Response('{}', { status: 404 }); }) as unknown as typeof fetch;
  const t = Date.parse('2026-11-27T10:00:00Z');
  assert.equal(await prSummary('o/r', 999, t, missing), null);
  assert.equal(await prSummary('o/r', 999, t + 30_000, missing), null);
  assert.equal(asked, 1, 'the second hover within a minute does not ask GitHub');
  await prSummary('o/r', 999, t + 61_000, missing);
  assert.equal(asked, 2);
  const down = (async () => { asked++; return new Response('{}', { status: 502 }); }) as unknown as typeof fetch;
  await assert.rejects(prSummary('o/r', 5, t, down), /502/);
  await assert.rejects(prSummary('o/r', 5, t + 10_000, down), /502/);
  assert.equal(asked, 3, 'a failure is not retried at once either');
});

test('on a phone: the first tap previews, and the card is a sheet at the bottom that stays on screen', async () => {
  const { tapToPreview } = await import('../app/pr-card');
  assert.equal(tapToPreview(), false, 'no window: no tap preview');
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 640px\) \{\n  \.pr-card \{ position: fixed; left: 8px; right: 8px;[^}]*width: auto; max-height: 60vh/);
  const src = readFileSync(new URL('../app/pr-card.tsx', import.meta.url), 'utf8');
  assert.match(src, /if \(open \|\| !tapToPreview\(\)\) return;\n    e\.preventDefault\(\);/, 'the first tap does not follow the link');
  assert.match(src, /document\.addEventListener\('pointerdown', away\)/, 'a tap elsewhere closes it');
});
