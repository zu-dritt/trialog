// «s» and «b» press Ship it and Build it on the selected message; Esc leaves the message box
// (playground #1057, #1058).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHORTCUTS, shortcutButton, shortcutFor } from '../app/shortcuts';

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: null, ...extra });

test('s is Ship it and b is Build it, also with Caps Lock; never while typing or with a modifier', () => {
  assert.equal(shortcutFor(key('s')), 'ship');
  assert.equal(shortcutFor(key('S')), 'ship');
  assert.equal(shortcutFor(key('b')), 'build');
  assert.equal(shortcutFor(key('s', { target: { tagName: 'TEXTAREA' } })), null);
  assert.equal(shortcutFor(key('b', { metaKey: true })), null);
});

/** A tiny stand-in for a message element, enough for querySelector. */
function messageWith(buttons: Record<string, { disabled?: boolean; pressed?: boolean }>) {
  const made = Object.fromEntries(Object.entries(buttons).map(([sel, b]) => [sel, {
    disabled: !!b.disabled,
    getAttribute: (name: string) => (name === 'aria-pressed' ? String(!!b.pressed) : null),
  }]));
  return { querySelector: (sel: string) => made[sel] ?? null } as unknown as ParentNode;
}

test('the button: Ship it or Build it when it is there and can be pressed', () => {
  const both = messageWith({ 'button[data-ship]': {}, 'button[data-build]': {} });
  assert.ok(shortcutButton(both, 'ship'));
  assert.ok(shortcutButton(both, 'build'));
  assert.equal(shortcutButton(messageWith({}), 'ship'), null, 'no Ship it on this message');
  assert.equal(shortcutButton(messageWith({ 'button[data-build]': { disabled: true } }), 'build'), null, 'Build it greyed out');
  assert.equal(shortcutButton(null, 'ship'), null, 'nothing selected');
});

test('s never takes a go back: a go already given stays', () => {
  assert.equal(shortcutButton(messageWith({ 'button[data-ship]': { pressed: true } }), 'ship'), null);
});

test('the «?» list names s, b, and Esc in the message box', () => {
  const keys = SHORTCUTS.map((s) => s.keys);
  assert.ok(keys.includes('s') && keys.includes('b'));
  assert.match(SHORTCUTS.find((s) => s.keys === 'Esc')!.action, /message box/);
});

test('the pane wires it up: s and b on the selected message, Esc blurs the box and keeps the draft', () => {
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /case 'ship':\s*case 'build': \{[\s\S]*?shortcutButton\(selected === null \? null : listRef\.current\?\.querySelector\(`#m-\$\{selected\}`\), action\)/);
  assert.match(pane, /e\.key === 'Escape' && !e\.nativeEvent\.isComposing\) \{ e\.preventDefault\(\); e\.currentTarget\.blur\(\); \}/);
  assert.ok(!/setDraft\(''\)[^\n]*Escape/.test(pane), 'Esc does not clear the draft');
});
