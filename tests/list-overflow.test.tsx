// The message list never scrolls sideways (playground #857): David saw a grey bar above the strip.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'vitest';

test('the list hides sideways overflow; long words wrap; wide tables scroll in their own box', () => {
  const pane = readFileSync(new URL('../app/pane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /<main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"/);
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.md \{ overflow-wrap: anywhere; \}/);
  assert.match(css, /\.md table \{[^}]*display: block; max-width: 100%; overflow-x: auto; \}/);
});
