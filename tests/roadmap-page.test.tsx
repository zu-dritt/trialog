// The roadmap page: where a card lands, the board as it renders, and the way to it from the hub.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoadmapBoard, columnOf, placeAt } from '../app/roadmap-board';
import { todayLine, type RoadmapItem } from '../lib/roadmap';

const card = (id: string, column: RoadmapItem['column'], position: number, over: Partial<RoadmapItem> = {}): RoadmapItem =>
  ({ id, column, position, title: `T ${id}`, note: '', owner: null, updated_by: 'claude', updated_at: '2026-11-27T08:00:00.000Z', progress: null, status: '', progress_at: null, description: '', attachments: [], reviewer: null, ...over });

test('a card lands where it is put, from its own column or another', () => {
  assert.deepEqual(placeAt(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(placeAt(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(placeAt(['a', 'b'], 'x', 1), ['a', 'x', 'b'], 'from another column');
  assert.deepEqual(placeAt(['a', 'b'], 'x', 99), ['a', 'b', 'x'], 'past the end: at the end');
  assert.deepEqual(placeAt(['a', 'b'], 'b', -1), ['b', 'a'], 'before the start: first');
});

test('a column lists its cards by position', () => {
  const items = [card('b', 'next', 1), card('a', 'next', 0), card('d', 'done', 0)];
  assert.deepEqual(columnOf(items, 'next').map((i) => i.id), ['a', 'b']);
});

test('the board: four columns, numbered cards, owners, and the controls only when it can change', () => {
  const items = [card('rm_aaaaaaaa', 'next', 0, { title: 'Deploy button', owner: 'grok', note: 'one click' }), card('rm_bbbbbbbb', 'next', 1, { title: 'Hovercard' })];
  const view = renderToStaticMarkup(<RoadmapBoard items={items} />);
  assert.deepEqual([...view.matchAll(/data-column="([a-z]+)"/g)].map((m) => m[1]), ['done', 'now', 'next', 'later']);
  assert.match(view, /Deploy button<\/div><div class="mt-0\.5 text-xs text-muted"><span data-role="owner" class="font-semibold"[^>]*>Grok<\/span> builds · one click/);
  assert.ok(!view.includes('↑') && !view.includes('draggable="true"'), 'read-only without actions');
  const live = renderToStaticMarkup(<RoadmapBoard items={items} actions={{ place: () => {} }} />);
  assert.equal(live.match(/draggable="true"/g)?.length, 2);
  const button = (label: string) => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(live)?.[0] ?? '';
  assert.match(button('Move «Deploy button» up'), /disabled=""/, 'the first card cannot go up');
  assert.match(button('Move «Hovercard» down'), /disabled=""/, 'the last card cannot go down');
  assert.doesNotMatch(button('Move «Hovercard» up'), /disabled=""/);
  assert.match(live, /<span class="sr-only">Column of «Hovercard»<\/span><select/);
});

test('the hub links the roadmap in the header and in the «⋯» menu, in a tab of its own', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /href="\/roadmap" target="trialog-roadmap"/);
  assert.match(page, /\{ label: 'Roadmap', href: '\/roadmap', target: 'trialog-roadmap' \}/);
});

test('a card with no owner offers «Claim»; your own offers «Release»; done cards neither', () => {
  const items = [card('rm_cccccccc', 'next', 0), card('rm_dddddddd', 'next', 1, { owner: 'claude' }), card('rm_eeeeeeee', 'next', 2, { owner: 'grok' }), card('rm_ffffffff', 'done', 0)];
  const html = renderToStaticMarkup(<RoadmapBoard items={items} me="claude" actions={{ place: () => {}, claim: () => {} }} />);
  assert.deepEqual([...html.matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]), ['rm_cccccccc']);
  assert.deepEqual([...html.matchAll(/data-release="([^"]+)"/g)].map((m) => m[1]), ['rm_dddddddd']);
  assert.ok(!renderToStaticMarkup(<RoadmapBoard items={items} actions={{ place: () => {}, claim: () => {} }} />).includes('data-claim'), 'no claim without knowing who you are');
});

test('the roadmap tab is named «Trialog Roadmap»', async () => {
  const { metadata } = await import('../app/roadmap/layout');
  assert.equal(metadata.title, 'Trialog Roadmap');
  assert.match(readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8'), /document\.title = 'Trialog Roadmap'/);
});

test('the «likely today» line: today’s pace times the hours left, less the cards in Now', () => {
  const at = (h: number, m = 0) => { const d = new Date(2026, 10, 27, h, m); return d; };
  const iso = (h: number, m = 0) => at(h, m).toISOString();
  // Four cards done between 08:00 and 12:00: one an hour. 12:00 → 19:00 leaves 7 h, so 7 cards;
  // one is still in Now, so 6 from Next.
  const done = [9, 10, 11, 12].map((h, n) => card(`rm_done000${n}`, 'done', n, { updated_at: iso(h) }));
  const yesterday = card('rm_old00000', 'done', 9, { updated_at: new Date(2026, 10, 26, 15).toISOString() });
  const next = Array.from({ length: 9 }, (_, n) => card(`rm_next000${n}`, 'next', n));
  const items = [...done, yesterday, card('rm_now00000', 'now', 0), ...next];
  assert.deepEqual(todayLine(items, at(12)), { fits: 6, done: 4, hours: 4, left: 7 });
  assert.equal(todayLine([yesterday, ...next], at(12)), null, 'no pace before the first card done today');
  assert.equal(todayLine(items, at(19, 30))?.fits, 0, 'after 19:00 nothing more');
  assert.equal(todayLine(items, at(12), 13)?.fits, 0, 'one hour left, one card in Now: nothing from Next');

  const view = renderToStaticMarkup(<RoadmapBoard items={items} now={at(12)} actions={{ place: () => {} }} />);
  const nextColumn = view.slice(view.indexOf('data-column="next"'), view.indexOf('data-column="later"'));
  const order = [...nextColumn.matchAll(/data-card-id="([a-z0-9_]+)"|data-today-line="(\d+)"/g)].map((m) => m[1] ?? 'LINE');
  assert.deepEqual(order.slice(5, 8), ['rm_next0005', 'LINE', 'rm_next0006'], 'the line after the sixth card');
  assert.match(nextColumn, /▲ likely today: the 6 above · 4 done in 4 h, 7 h left/);
  assert.ok(!view.slice(0, view.indexOf('data-column="next"')).includes('data-today-line'), 'only in Next');

  // Reordered: the line stays after six cards, whichever they are.
  const moved = items.map((i) => (i.id === 'rm_next0008' ? { ...i, position: -1 } : i));
  const after = renderToStaticMarkup(<RoadmapBoard items={moved} now={at(12)} />);
  const ids = [...after.slice(after.indexOf('data-column="next"')).matchAll(/data-card-id="([a-z0-9_]+)"|data-today-line="(\d+)"/g)].map((m) => m[1] ?? 'LINE');
  assert.deepEqual(ids.slice(0, 7), ['rm_next0008', 'rm_next0000', 'rm_next0001', 'rm_next0002', 'rm_next0003', 'rm_next0004', 'LINE']);

  const few = renderToStaticMarkup(<RoadmapBoard items={[...done, ...next.slice(0, 2)]} now={at(12)} />);
  assert.match(few, /▲ all of Next likely today/, 'when everything fits, the line sits at the end');
});

test('«✎ Compose» sits at the top of Later when the page can add and upload, and opens a full window', async () => {
  const add = { place: () => {}, addIdea: async () => true, upload: async () => ({ id: 'att_x', content_type: 'image/png' as const, width: 1, height: 1, bytes: 1, scale: 1 }) };
  const html = renderToStaticMarkup(<RoadmapBoard items={[]} actions={add} />);
  assert.equal(html.match(/data-compose=""/g)?.length, 1);
  assert.match(html, /data-column="later"[^]*data-compose=""[^>]*>[^]*Compose/);
  assert.ok(!html.includes('data-idea-box'), 'the one-line field is gone (playground #638)');
  assert.ok(!renderToStaticMarkup(<RoadmapBoard items={[]} actions={{ place: () => {}, addIdea: async () => true }} />).includes('data-compose'), 'no upload, no Compose');
  const { composeState } = await import('../app/compose-idea');
  assert.deepEqual(composeState('', [], false), { ready: false, label: 'Add to Later' }, 'a title is needed');
  assert.deepEqual(composeState('Idea', [{ state: 'uploading' }], false), { ready: false, label: 'Uploading…' });
  assert.deepEqual(composeState('Idea', [{ state: 'failed' }], false).ready, false, 'a failed picture must be removed first');
  assert.deepEqual(composeState('Idea', [{ state: 'ready' }], false), { ready: true, label: 'Add to Later' });
  assert.deepEqual(composeState('Idea', [], true), { ready: false, label: 'Adding…' });
  const page = readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /column: 'later', title, note: `💡 idea from \$\{who\}`\.slice\(0, 120\), description, attachments, top: true/);
  const compose = readFileSync(new URL('../app/compose-idea.tsx', import.meta.url), 'utf8');
  assert.match(compose, /onPaste=\{paste\}/, 'pictures can be pasted');
});

test('a card with a description and pictures shows the first line, and opens to the rest', () => {
  const pic = { id: 'att_one', content_type: 'image/png' as const, width: 40, height: 20, bytes: 9, scale: 1 };
  const items = [card('rm_details00', 'later', 0, { description: 'Like Gmail Compose\nwith pictures', attachments: [pic] }), card('rm_plain0000', 'later', 1)];
  const html = renderToStaticMarkup(<RoadmapBoard items={items} loadImage={async () => 'blob:x'} />);
  assert.equal(html.match(/data-details=""/g)?.length, 1, 'only the card that has details');
  assert.match(html, /<summary[^>]*>🖼 1 · Like Gmail Compose<\/summary>/);
  assert.match(html, /whitespace-pre-wrap[^>]*>Like Gmail Compose\nwith pictures<\/p>/);
});

test('the today label keeps «7 h left» and «4 done in 4 h» together, so a narrow column wraps between them', async () => {
  const { todayLineText } = await import('../app/roadmap-board');
  const text = todayLineText({ fits: 2, done: 13, hours: 6, left: 5 }, 9);
  assert.equal(text, '▲ likely today: the 2 above · 13\u00a0done in\u00a06\u00a0h, 5\u00a0h\u00a0left');
});

test('card LEDs: red and blinking when a card waits on the orchestrator, amber in review, green or grey in Now', async () => {
  const { cardStatus } = await import('../lib/roadmap');
  const T = Date.parse('2026-11-27T12:00:00Z');
  const c = (column: RoadmapItem['column'], note: string, over: Partial<RoadmapItem> = {}) => ({ column, note, owner: 'claude', updated_at: '2026-11-27T11:30:00Z', ...over });
  assert.equal(cardStatus(c('now', '⛔ WAITING ON DAVID: merge apartment-finder PR 37'), T)?.tone, 'blocked');
  assert.equal(cardStatus(c('next', 'David: your call on the first breaks'), T)?.tone, 'blocked', 'in Next too: «Name: step», as in a flight');
  assert.equal(cardStatus(c('later', 'waiting on the orchestrator'), T)?.tone, 'blocked');
  assert.equal(cardStatus(c('now', 'Orchestrator: go for the demo'), T)?.tone, 'blocked', 'by label as well');
  assert.equal(cardStatus(c('now', 'PR 86, in review'), T)?.tone, 'review');
  assert.equal(cardStatus(c('now', 'new: from the pace'), T)?.tone, 'working');
  assert.deepEqual(cardStatus(c('now', 'new', { updated_at: '2026-11-27T07:00:00Z' }), T), { tone: 'stale', label: 'no change for 5 h' });
  assert.equal(cardStatus(c('now', 'nobody has it', { owner: null }), T), null, 'no owner, no work');
  assert.equal(cardStatus(c('next', 'queued'), T), null, 'queued cards stay quiet');
  assert.equal(cardStatus(c('done', '⛔ old note'), T), null, 'done is done');
  assert.equal(cardStatus(c('now', 'Davidson: not him'), T)?.tone, 'working', 'whole names only');
  assert.equal(cardStatus(c('next', 'your call: clean start or today’s breaks', { owner: 'david' }), T)?.tone, 'blocked', 'the orchestrator’s own card waits on him');
  assert.equal(cardStatus(c('now', 'trying the demo', { owner: 'david' }), T)?.tone, 'working', 'his own card in Now: he is on it, no blink');

  const P = [{ name: 'david', kind: 'human', label: 'Orchestrator', color: 'blue' }, { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' }] as never;
  const items = [card('rm_blocked00', 'now', 0, { owner: 'claude', note: 'David: merge apartment-finder PR 37', updated_at: new Date(T - 60_000).toISOString() }), card('rm_review000', 'now', 1, { owner: 'grok', note: 'PR 87, in review' }), card('rm_done00000', 'done', 0, { owner: 'claude', note: 'live (PR 85)' })];
  const html = renderToStaticMarkup(<RoadmapBoard items={items} participants={P} now={new Date(T)} actions={{ place: () => {} }} />);
  assert.match(html, /data-led="blocked"[^>]*><span aria-hidden="true" class="[^"]*blink-red[^"]*" style="background:#f85149"><\/span>waiting on you/);
  assert.match(html, /data-led="review"/);
  const done = html.slice(html.indexOf('data-column="done"'), html.indexOf('data-column="now"'));
  assert.ok(!done.includes('<select') && !done.includes('data-led'), 'Done: no column menu, no LED');
  assert.ok(done.includes('draggable="true"'), 'a done card can still be dragged back');
  assert.equal(html.match(/<select/g)?.length, 2, 'the menu stays on the cards in Now');
});

test('a red card with an address in its note gets «Unblock →», and every address in a note is a link', async () => {
  const { unblockHref, cardStatus } = await import('../lib/roadmap');
  const url = 'https://github.com/amberleaf-gmbh/apartment-finder/pull/37';
  const T = Date.parse('2026-11-27T12:00:00Z');
  const blocked = { column: 'now' as const, note: `⛔ WAITING ON DAVID: merge ${url}.`, owner: 'claude', updated_at: '2026-11-27T11:50:00Z' };
  assert.equal(unblockHref(blocked, cardStatus(blocked, T)), url, 'the address, without the full stop');
  assert.equal(unblockHref({ note: `PR 88, in review: ${url}` }, { tone: 'review', label: 'in review' }), null, 'only red cards');
  assert.equal(unblockHref({ note: '⛔ your call on the breaks' }, { tone: 'blocked', label: 'waiting on you' }), null, 'no address, no button');

  const P = [{ name: 'david', kind: 'human', label: 'Orchestrator', color: 'blue' }, { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' }] as never;
  const items = [card('rm_unblock00', 'now', 0, { owner: 'claude', note: blocked.note, updated_at: blocked.updated_at }), card('rm_review000', 'now', 1, { owner: 'claude', note: 'PR 88, in review: https://github.com/zu-dritt/trialog/pull/88' })];
  const html = renderToStaticMarkup(<RoadmapBoard items={items} participants={P} now={new Date(T)} actions={{ place: () => {} }} />);
  assert.equal(html.match(/data-unblock=""/g)?.length, 1);
  assert.match(html, new RegExp(`<a href="${url}" target="_blank" rel="noopener noreferrer" data-unblock="" draggable="false"[^>]*>Unblock → apartment-finder PR 37</a>`));
  assert.match(html, /<a href="https:\/\/github\.com\/zu-dritt\/trialog\/pull\/88"[^>]*>(?:trialog )?PR 88<\/a>/, 'the review card’s address is a link too');
});

test('every card says who builds and who reviews: «Claude builds · Grok reviews», «built · reviewed» in Done', async () => {
  const { cardRoles } = await import('../app/roadmap-board');
  const P = [{ name: 'david', kind: 'human' as const }, { name: 'claude', kind: 'agent' as const }, { name: 'grok', kind: 'agent' as const }];
  assert.deepEqual(cardRoles({ column: 'now', owner: 'claude', reviewer: 'grok' }, P).map((r) => `${r.name} ${r.verb}`), ['claude builds', 'grok reviews']);
  assert.deepEqual(cardRoles({ column: 'done', owner: 'claude', reviewer: 'grok' }, P).map((r) => `${r.name} ${r.verb}`), ['claude built', 'grok reviewed']);
  assert.deepEqual(cardRoles({ column: 'next', owner: 'david', reviewer: null }, P).map((r) => `${r.name}|${r.verb}`), ['david|'], 'the orchestrator decides, he is not «building»');
  assert.deepEqual(cardRoles({ column: 'next', owner: null, reviewer: 'grok' }, P).map((r) => r.role), ['reviewer']);
  assert.deepEqual(cardRoles({ column: 'now', owner: 'claude', reviewer: 'claude' }, P).length, 1, 'no one reviews their own');
  const html = renderToStaticMarkup(<RoadmapBoard items={[card('rm_rev00000', 'now', 0, { owner: 'claude', reviewer: 'grok', note: 'PR 93' })]} participants={[{ name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' }, { name: 'grok', kind: 'agent', label: 'Grok', color: 'orange' }] as never} />);
  assert.match(html, /<span data-role="owner"[^>]*>Claude<\/span> builds · <span data-role="reviewer"[^>]*>Grok<\/span> reviews · PR 93/);
});

test('the roadmap shows the work-in-flight strip above the board: who does what, and what waits', () => {
  const page = readFileSync(new URL('../app/roadmap/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /data-roadmap-flight=""[^]*<FlightBar token=\{token\} onUnauthorized=\{\(\) => setToken\(''\)\} participants=\{participants\} position="top" \/>/);
  assert.ok(page.indexOf('data-roadmap-flight') < page.indexOf('<RoadmapBoard'), 'above the board');
});

test('a progress bar on cards that say how far they are: percent, the owner\'s line, how long ago; not in Done', () => {
  const T = Date.parse('2026-11-27T14:00:00Z');
  const items = [
    card('rm_prog0000', 'now', 0, { owner: 'claude', progress: 60, status: 'geocoding done', progress_at: '2026-11-27T13:48:00Z' }),
    card('rm_none0000', 'now', 1, { owner: 'grok' }),
    card('rm_done0000', 'done', 0, { owner: 'claude', progress: 100, status: 'live', progress_at: '2026-11-27T13:00:00Z' }),
  ];
  const html = renderToStaticMarkup(<RoadmapBoard items={items} now={new Date(T)} />);
  assert.equal(html.match(/role="progressbar"/g)?.length, 1, 'only the card in Now that said how far it is');
  assert.match(html, /aria-valuenow="60" aria-label="60% done: geocoding done"/);
  assert.match(html, /style="width:60%"/);
  assert.match(html, />60%<\/span> · geocoding done · 12 min ago/);
});
