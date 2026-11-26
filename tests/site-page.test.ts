// Keeps docs/site/index.html honest: it loads nothing from anywhere else, and
// it has the film, the sentence, the two links and the board.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const siteDir = fileURLToPath(new URL('../docs/site/', import.meta.url));
const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
const redirect = readFileSync(new URL('../docs/how-a-message-travels.html', import.meta.url), 'utf8');

const ALLOWED_HOSTS = [
  /^https:\/\/github\.com\/zu-dritt\/trialog(\/|$)/,
  /^https:\/\/trialog\.dev\/?$/,
  /^https:\/\/trialog\.dev\/assets\//,
];

test('front page: small, strict CSP, nothing loaded from elsewhere', () => {
  assert.ok(Buffer.byteLength(html) < 20_000, 'the page stays under 20 KB');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /@import/);

  const hrefs = new Set([...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]));
  for (const [url] of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const allowed = ALLOWED_HOSTS.some((re) => re.test(url));
    assert.ok(allowed, `${url} is not a repo or trialog.dev URL`);
    const inLink = hrefs.has(url);
    const inMeta = new RegExp(`<(?:meta|link)\\b[^>]*(?:content|href)="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html);
    assert.ok(inLink || inMeta, `${url} appears outside a plain link or a meta tag`);
  }

  // Loadable addresses (src, stylesheet href, CSS url()) stay on this site.
  for (const [, url] of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
    if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('//')) {
      assert.ok(hrefs.has(url), `loadable address ${url} is not a plain link`);
    } else {
      assert.doesNotMatch(url, /^[a-z]+:/i, `unexpected scheme in ${url}`);
    }
  }
  assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie/);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('front page: the film, the sentence, the two links and the board', () => {
  assert.match(html, /One chat where the human orchestrator and two AI agents, Grok and Claude, build software together\./);
  assert.match(html, /<a class="primary" href="try\.html">Try it in your browser<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/zu-dritt\/trialog">Run your own<\/a>/);
  assert.match(html, /<h2 id="board-h">The board<\/h2>/);
  assert.match(html, /<source src="assets\/trialog-in-action\.mp4" type="video\/mp4">/);
  assert.match(html, /poster="assets\/poster\.jpg"/);
  assert.match(html, /src="assets\/board\.png"/);
  assert.match(html, /<video\b[^>]*\bcontrols\b/i);
  assert.doesNotMatch(html, /\bautoplay\b/i);

  const video = join(siteDir, 'assets/trialog-in-action.mp4');
  const poster = join(siteDir, 'assets/poster.jpg');
  const board = join(siteDir, 'assets/board.png');
  assert.ok(existsSync(video) && existsSync(poster) && existsSync(board), 'the film, poster and board files are present');
  const videoBytes = statSync(video).size;
  assert.ok(videoBytes > 100_000, 'the film is more than an empty file');
  assert.ok(videoBytes <= 3 * 1024 * 1024, `the film stays at most 3 MB (${videoBytes} bytes)`);
});

test('old explainer path redirects to docs/site/try.html', () => {
  assert.match(redirect, /url=site\/try\.html/);
  assert.match(redirect, /href="site\/try\.html"/);
  assert.match(redirect, /Content-Security-Policy" content="default-src 'none'/);
  assert.ok(existsSync(join(siteDir, 'try.html')));
});
