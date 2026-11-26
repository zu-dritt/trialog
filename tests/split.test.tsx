// Split view, as far as it can be checked without a browser: the stored choice, which room the
// second pane opens on, and whether two panes fit. The live streams, the two composers and the
// narrow fallback need a real browser and are checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSecondRoom, readSplit, splitFits, splitKey, writeSplit, SPLIT_MIN_WIDTH_PX } from '../app/split';
import { SplitToggle } from '../app/split-ui';
import { RoomPicker } from '../app/pane';
import { seenElsewhere } from '../app/rooms';

function storage(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  return {
    kept,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => { kept.set(k, v); },
    removeItem: (k: string) => { kept.delete(k); },
  };
}

test('split view is off by default, and the choice is kept per participant', () => {
  const s = storage();
  assert.deepEqual(readSplit(s, 'david'), { open: false, room: 'main' });
  writeSplit(s, 'david', { open: true, room: 'calm' });
  assert.deepEqual(readSplit(s, 'david'), { open: true, room: 'calm' });
  assert.deepEqual(readSplit(s, 'ana'), { open: false, room: 'main' }, 'another participant at the same browser starts off');
  assert.equal(splitKey('david'), 'trialogSplit:david');

  for (const junk of ['not json', '[]', 'null', '"x"']) {
    const broken = storage({ [splitKey('david')]: junk });
    assert.deepEqual(readSplit(broken, 'david'), { open: false, room: 'main' }, junk);
  }
  // open must be exactly true; a truthy 1 is treated as off.
  assert.deepEqual(readSplit(storage({ [splitKey('david')]: '{"open":1,"room":"calm"}' }), 'david'), { open: false, room: 'calm' });
  // A bad room id falls back to main; a valid open is kept.
  assert.deepEqual(readSplit(storage({ [splitKey('david')]: '{"open":true,"room":"Not An Id"}' }), 'david'), { open: true, room: 'main' });
  const off = { getItem: () => { throw new Error('storage is off'); }, setItem: () => { throw new Error('storage is off'); } };
  assert.deepEqual(readSplit(off, 'david'), { open: false, room: 'main' });
  assert.doesNotThrow(() => writeSplit(off, 'david', { open: true, room: 'calm' }));
});

test('the second pane opens on another room when there is one, otherwise Main', () => {
  const rooms = [{ id: 'main' }, { id: 'calm' }, { id: 'dev' }];
  assert.equal(defaultSecondRoom(rooms, 'main'), 'calm');
  assert.equal(defaultSecondRoom(rooms, 'calm'), 'main');
  assert.equal(defaultSecondRoom([{ id: 'main' }], 'main'), 'main');
  assert.equal(defaultSecondRoom([], 'main'), 'main');
});

test('two panes fit from the same width as the wide header layout', () => {
  assert.equal(SPLIT_MIN_WIDTH_PX, 1024);
  assert.equal(splitFits(1023), false);
  assert.equal(splitFits(1024), true);
  assert.equal(splitFits(1600), true);
});

test('a window with two rooms open does not count either as unseen', () => {
  const seen = { main: 12, calm: 40, dev: 3 };
  assert.deepEqual(seenElsewhere(seen, 'main'), { calm: 40, dev: 3 });
  assert.deepEqual(seenElsewhere(seen, 'main', 'calm'), { dev: 3 });
  assert.deepEqual(seenElsewhere(seen, 'main', 'calm', 'dev'), {});
});

test('the toggle says whether two rooms are shown, and why it may be unusable', () => {
  const on = renderToStaticMarkup(<SplitToggle on onToggle={() => {}} />);
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /aria-label="Show one room"/);
  const off = renderToStaticMarkup(<SplitToggle on={false} onToggle={() => {}} />);
  assert.match(off, /aria-pressed="false"/);
  assert.match(off, /aria-label="Show two rooms side by side"/);
  const tight = renderToStaticMarkup(<SplitToggle on={false} onToggle={() => {}} disabled />);
  assert.match(tight, /disabled=""/);
  assert.match(tight, /Split view needs a wider window/);
});

test('the second pane picker names the room in that pane', () => {
  const rooms = [
    { id: 'main', name: 'Main', created_at: '', created_by: 'hub', last_id: 0 },
    { id: 'calm', name: 'Calm', created_at: '', created_by: 'hub', last_id: 0, unread: 3 },
  ];
  const html = renderToStaticMarkup(<RoomPicker rooms={rooms} current="calm" onPick={() => {}} />);
  assert.match(html, /aria-label="Room in this pane"/);
  assert.match(html, /<option[^>]*value="calm"[^>]*>Calm \(3\)<\/option>/);
  assert.match(html, /<option[^>]*value="main"[^>]*>Main<\/option>/);
});
