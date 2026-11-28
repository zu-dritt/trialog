// Keeps docs/site/index.html honest: it loads nothing from anywhere else, and
// it has the film, the sentence, the two links and the board.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

function iconHrefs(pageHtml: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of pageHtml.matchAll(/<link\b[^>]*>/gi)) {
    const rel = tag.match(/\brel="([^"]+)"/i)?.[1] ?? '';
    const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
    if (href && /\b(icon|apple-touch-icon)\b/i.test(rel)) hrefs.push(href);
  }
  return hrefs;
}

test('every site page links a favicon, and the file is there', () => {
  const pages = [
    join(siteDir, 'index.html'),
    ...readdirSync(siteDir).filter((name) => name.endsWith('.html')).map((name) => join(siteDir, name)),
    fileURLToPath(new URL('../docs/how-a-message-travels.html', import.meta.url)),
  ];
  const seen = new Set<string>();
  let count = 0;
  for (const page of pages) {
    if (seen.has(page)) continue;
    seen.add(page);
    const pageHtml = readFileSync(page, 'utf8');
    const hrefs = iconHrefs(pageHtml);
    assert.ok(hrefs.length > 0, `${page} links an icon`);
    for (const href of hrefs) {
      assert.doesNotMatch(href, /^(?:[a-z]+:)?\/\//i, `${page} icon is not a local file: ${href}`);
      assert.ok(existsSync(join(dirname(page), href)), `${page} missing icon file: ${href}`);
    }
    assert.match(pageHtml, /img-src 'self'/, `${page} CSP must allow a local icon`);
    count++;
  }
  assert.ok(count >= 3, 'the front page, the explainer and the redirect are all checked');
});

test('trialog.dev invites search engines and agents: robots.txt, a sitemap of every page, llms.txt', () => {
  const robots = readFileSync(join(siteDir, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.doesNotMatch(robots, /^Disallow: \/\s*$/m);
  assert.match(robots, /^Sitemap: https:\/\/trialog\.dev\/sitemap\.xml$/m);

  const sitemap = readFileSync(join(siteDir, 'sitemap.xml'), 'utf8');
  const listed = [...sitemap.matchAll(/<loc>https:\/\/trialog\.dev\/([^<]*)<\/loc>/g)].map((m) => m[1] || 'index.html').sort();
  const pages = readdirSync(siteDir).filter((f) => f.endsWith('.html')).sort();
  assert.deepEqual(listed, pages, 'every page is in the sitemap, and nothing else');

  for (const page of pages) {
    const text = readFileSync(join(siteDir, page), 'utf8');
    assert.doesNotMatch(text, /<meta name="robots"[^>]*noindex/i, `${page} is not hidden from search`);
  }

  const llms = readFileSync(join(siteDir, 'llms.txt'), 'utf8');
  assert.match(llms, /^# Trialog\n\n> /);
  for (const page of pages) assert.ok(llms.includes(`https://trialog.dev/${page === 'index.html' ? '' : page})`), `llms.txt links ${page}`);
});
