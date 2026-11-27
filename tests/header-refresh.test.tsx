// The header refresh (playground #539, go in #757): by how often things are used. Roadmap is a filled
// button, then «?», then «⋯», which holds who you are, the demo hub, the wake-ups, Export and Switch token.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { MoreMenu } from '../app/more-menu';
import { wakeTargetsText } from '../app/wakes';

const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

test('the header row ends with Roadmap, «?» and «⋯», and has no Export, Switch token or «You» any more', () => {
  const header = page.slice(page.indexOf('<header'), page.indexOf('</header>'));
  const order = ['<SoundToggle', '<SplitToggle', '<SearchBox', 'Roadmap ↗</a>', '<TourButton', '<MoreMenu'].map((s) => header.indexOf(s));
  assert.ok(order.every((i) => i >= 0), 'all six are in the header');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.ok(!/>Export \.md<|>Switch token<|>You: /.test(header), 'no rarely used buttons in the row');
  assert.match(header, /border-accent bg-accent[^"]*" href="\/roadmap"/, 'Roadmap is a filled button');
  assert.ok(!page.includes('<WakeTargetsLine'), 'the wake-ups line above the chat is gone');
});

test('«⋯» lists who you are, Demo hub, the wake-ups, Export .md, and Switch token last after a line', () => {
  const items = [
    { label: 'Roadmap', href: '/roadmap', target: 'trialog-roadmap', className: 'sm:hidden' },
    { label: 'Demo hub', href: 'https://demo.example/' },
    { label: 'Wake-ups: none set', info: true as const },
    { label: 'Export .md', onPick: () => {} },
    { label: 'Switch token', onPick: () => {}, divider: true },
  ];
  const html = renderToStaticMarkup(<MoreMenu heading={<>Signed in as <b>Orchestrator</b></>} items={items} initiallyOpen />);
  const texts = [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  assert.deepEqual(texts, ['⋯', 'Signed in as', 'Orchestrator', 'Roadmap ↗', 'Demo hub ↗', 'Wake-ups: none set', 'Export .md', 'Switch token']);
  assert.match(html, /<a role="menuitem" href="\/roadmap" target="trialog-roadmap"[^>]*sm:hidden/, 'Roadmap in the menu only on a phone');
  assert.match(html, /<div role="none" class="[^"]*text-muted[^"]*">Wake-ups: none set<\/div>/, 'the wake-ups are text, not a button');
  assert.match(html, /<button type="button" role="menuitem" class="[^"]*border-t border-line[^"]*">Switch token</, 'a line above Switch token');
  assert.equal([...html.matchAll(/role="menuitem"/g)].length, 4);
});

test('the wake-ups text is for humans only, and names who has a target', () => {
  const people = [
    { name: 'ana', kind: 'human' as const, color: 0, wake_target_host: null, wake_target_set_at: null },
    { name: 'scout', kind: 'agent' as const, color: 1, wake_target_host: 'scout.example', wake_target_set_at: null },
  ];
  assert.match(wakeTargetsText('ana', people) ?? '', /^Wake-ups: .*\(scout\.example\)$/);
  assert.equal(wakeTargetsText('scout', people), null);
  assert.equal(wakeTargetsText('ana', [{ ...people[0], wake_target_host: null }]), 'Wake-ups: none set');
});

test('the search field is wider and names its key', () => {
  const search = readFileSync(new URL('../app/search.tsx', import.meta.url), 'utf8');
  assert.match(search, /md:max-w-\[520px\]/);
  assert.match(search, /placeholder="Search messages and decisions \(\/\)"/);
});
