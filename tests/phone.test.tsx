// The page at phone width, as far as it can be checked without a browser: the «⋯» menu that holds
// Export .md and Switch token there, the viewport that lets iOS report the notch, and the header's
// classes that hide or fold what does not fit below the sm breakpoint. The look on a real phone is
// checked by hand on the iPhone simulator.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoreMenu } from '../app/more-menu';
import { viewport } from '../app/layout';

const items = [{ label: 'Export .md', onPick: () => {} }, { label: 'Switch token', onPick: () => {} }];

test('the «⋯» menu is closed at first: only its button, which says it opens a menu', () => {
  const html = renderToStaticMarkup(<MoreMenu items={items} className="sm:hidden" />);
  assert.match(html, /class="relative flex-none sm:hidden"/);
  assert.match(html, /aria-label="More"[^>]*aria-haspopup="menu" aria-expanded="false"/);
  assert.doesNotMatch(html, /Export \.md/);
});

test('open, the menu lists its items in order, as menu items', () => {
  const html = renderToStaticMarkup(<MoreMenu items={items} initiallyOpen />);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /role="menu"/);
  const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Export .md', 'Switch token']);
});

test('the viewport reaches the screen edges, so the page can pad itself by the safe area', () => {
  assert.equal(viewport.viewportFit, 'cover');
  assert.equal(viewport.width, 'device-width');
});

test('the header keeps Roadmap and «?» out of the phone row, and «⋯» shows on every screen', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /no-underline hover:opacity-90 max-sm:hidden" href="\/roadmap"/);
  assert.match(page, /<TourButton [^>]*className="mx-1 max-sm:hidden" \/>/);
  assert.match(page, /<MoreMenu\s+heading=/, 'no sm:hidden on the menu any more');
  // The page is as tall as what is visible, and padded by the safe area.
  assert.match(page, /h-dvh/);
  assert.match(page, /pt-\[env\(safe-area-inset-top\)\]/);
});

test('a menu item with an address is a link that opens in a new tab', () => {
  const html = renderToStaticMarkup(<MoreMenu items={[...items, { label: 'Demo hub', href: 'https://demo.example/' }]} initiallyOpen />);
  assert.match(html, /<a role="menuitem" href="https:\/\/demo.example\/" target="_blank" rel="noopener noreferrer"[^>]*>Demo hub ↗<\/a>/);
});

test('the header shows the demo link only when the build has one', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /const DEMO_LINK = demoLink\(\);/);
  assert.doesNotMatch(page, /\{DEMO_LINK && <a /, 'the demo link lives in «⋯» only');
  assert.match(page, /\.\.\.\(DEMO_LINK \? \[\{ label: 'Demo hub', href: DEMO_LINK \}\] : \[\]\)/);
});
