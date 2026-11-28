// Keyboard shortcuts (playground #520): which keys are ours, when they stay out of the way, and where j / k go.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SHORTCUTS, ShortcutsHelp, shortcutFor, stepTo, typing } from '../app/shortcuts';

const el = (tagName: string, more: Record<string, unknown> = {}) => ({ tagName, ...more }) as unknown as EventTarget;

test('j k r n / ? and Esc are ours on the page', () => {
  const page = el('DIV');
  assert.deepEqual(['j', 'k', 'r', 'n', '/', '?', 'Escape', 'x'].map((key) => shortcutFor({ key, target: page })),
    ['next', 'previous', 'reply', 'compose', 'search', 'help', 'escape', null]);
});

test('never while typing, never with Ctrl, ⌘ or Alt, never mid-composition', () => {
  for (const target of [el('TEXTAREA'), el('INPUT', { type: 'text' }), el('INPUT', { type: 'search' }), el('SELECT'), el('DIV', { isContentEditable: true })]) {
    assert.equal(shortcutFor({ key: 'j', target }), null);
    assert.equal(typing(target), true);
  }
  assert.equal(shortcutFor({ key: 'j', target: el('INPUT', { type: 'checkbox' }) }), 'next', 'a checkbox is not typing');
  assert.equal(shortcutFor({ key: 'r', metaKey: true, target: el('DIV') }), null, '⌘R still reloads');
  assert.equal(shortcutFor({ key: 'k', ctrlKey: true, target: el('DIV') }), null);
  assert.equal(shortcutFor({ key: 'j', altKey: true, target: el('DIV') }), null);
  assert.equal(shortcutFor({ key: 'j', isComposing: true, target: el('DIV') }), null);
});

test('j and k step through the messages and stop at the ends; the first press starts at the newest', () => {
  const ids = [10, 11, 12];
  assert.equal(stepTo(ids, null, 'next'), 12);
  assert.equal(stepTo(ids, null, 'previous'), 12);
  assert.equal(stepTo(ids, 12, 'previous'), 11);
  assert.equal(stepTo(ids, 10, 'previous'), 10, 'the oldest stays');
  assert.equal(stepTo(ids, 11, 'next'), 12);
  assert.equal(stepTo(ids, 12, 'next'), 12, 'the newest stays');
  assert.equal(stepTo(ids, 99, 'next'), 12, 'a selection that left the list starts again at the newest');
  assert.equal(stepTo([], null, 'next'), null);
});

test('«?» lists every shortcut', () => {
  const html = renderToStaticMarkup(<ShortcutsHelp onClose={() => {}} />);
  assert.match(html, /role="dialog"[^>]*aria-label="Keyboard shortcuts"/);
  for (const s of SHORTCUTS) assert.ok(html.includes(`>${s.keys}</kbd>`), s.keys);
});

test('the leading pane listens, marks the selected message, and shows the list', () => {
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /useShortcuts\(lead, \(action\) =>/);
  assert.match(pane, /selected === m\.id \? 'shadow-\[inset_0_0_0_2px_var\(--color-accent\)\]'|marked === m\.id \|\| selected === m\.id/);
  assert.match(pane, /\{helpOpen && <ShortcutsHelp onClose=/);
});

test('Grok\'s nits on PR 79: J with Caps Lock or Shift, a real dialog, and «/» finds the search field by a data attribute', async () => {
  const page = { tagName: 'DIV' } as unknown as EventTarget;
  assert.deepEqual(['J', 'K', 'R', 'N'].map((key) => shortcutFor({ key, target: page })), ['next', 'previous', 'reply', 'compose']);
  assert.equal(shortcutFor({ key: '?', target: page }), 'help');
  const html = renderToStaticMarkup(<ShortcutsHelp onClose={() => {}} />);
  assert.match(html, /role="dialog" aria-modal="true"/);
  const { readFileSync } = await import('node:fs');
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /querySelector<HTMLInputElement>\('input\[data-search-field\]'\)/);
  assert.match(pane, /button\[data-search-opener\]'\)\?\.click\(\)/, 'on a phone «/» opens the folded search bar');
  const search = readFileSync(new URL('../app/search.tsx', import.meta.url), 'utf8');
  assert.match(search, /data-search-opener=""/);
  assert.match(search, /data-search-field=""/);
  const shortcuts = readFileSync(new URL('../app/shortcuts.tsx', import.meta.url), 'utf8');
  assert.match(shortcuts, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeRef\.current\(\); \}/, 'Esc closes it from the message box too');
});
