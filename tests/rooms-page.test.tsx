// Rooms on the page, as far as they can be checked without a browser: the room in the address,
// what this browser has seen, the draft of each room, and the markup of the tabs. Switching,
// creating a room, the live counts and the narrow layout need a real browser and are checked by
// hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { draftKey, draftScope, readDraft, writeDraft } from '../app/composer';
import { RoomTabs, addressForRoom, heldBack, markSeen, settled, readSeen, roomFromSearch, roomNameProblem, seenElsewhere, seenKey, tabLabel, unreadLabel, withSeen, withSeenApplied, writeSeen } from '../app/rooms';
import { SearchResults } from '../app/search';
import type { Message } from '../lib/core';
import { formatSeen, type Room } from '../lib/shared';

const room = (id: string, name: string, unread?: number): Room => ({ id, name, created_at: '2026-11-26T04:00:00.000Z', created_by: 'david', last_id: 7, ...(unread === undefined ? {} : { unread }) });
const ROOMS = [room('main', 'Main', 3), room('calm', 'Calm talk', 0), room('dev', 'Dev', 120)];
const noop = () => {};
const never = async () => '';

function storage(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  return {
    kept,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => { kept.set(k, v); },
    removeItem: (k: string) => { kept.delete(k); },
  };
}

test('the address names the room, and main needs nothing in it', () => {
  assert.equal(roomFromSearch(''), 'main');
  assert.equal(roomFromSearch('?room=calm'), 'calm');
  assert.equal(roomFromSearch('?x=1&room=calm-2'), 'calm-2');
  for (const bad of ['?room=', '?room=Not%20An%20Id', '?room=9lives', `?room=${'x'.repeat(25)}`, '?room=%3Cscript%3E']) assert.equal(roomFromSearch(bad), 'main', bad);

  assert.equal(addressForRoom('https://hub.test/', 'calm'), '/?room=calm');
  assert.equal(addressForRoom('https://hub.test/?room=calm', 'main'), '/');
  assert.equal(addressForRoom('https://hub.test/?room=calm&x=1#m-12', 'dev'), '/?room=dev&x=1#m-12', 'the rest of the address stays');
  assert.equal(roomFromSearch(new URL(addressForRoom('https://hub.test/', 'calm-2'), 'https://hub.test').search), 'calm-2');
});

test('what was seen is kept per participant, only moves forward, and survives a broken entry', () => {
  const s = storage();
  assert.deepEqual(readSeen(s, 'david'), {});
  let seen = withSeen({}, 'main', 12);
  seen = withSeen(seen, 'calm', 40);
  assert.deepEqual(seen, { main: 12, calm: 40 });
  assert.equal(withSeen(seen, 'main', 12), seen, 'nothing new: the same object, so nothing is written');
  assert.equal(withSeen(seen, 'main', 5), seen, 'never backwards');
  writeSeen(s, 'david', seen);
  assert.deepEqual(readSeen(s, 'david'), { main: 12, calm: 40 });
  assert.deepEqual(readSeen(s, 'ana'), {}, 'another participant at the same browser starts fresh');
  assert.equal(formatSeen(readSeen(s, 'david')), 'main:12,calm:40', 'as it is sent with the request for the counts');

  for (const junk of ['not json', '[]', 'null', '"x"', '{"main":"12","Bad Id":3,"calm":-1,"dev":1.5,"ok":9}']) {
    const broken = storage({ [seenKey('david')]: junk });
    assert.deepEqual(readSeen(broken, 'david'), junk.includes('"ok"') ? { ok: 9 } : {}, junk);
  }
  const off = { getItem: () => { throw new Error('storage is off'); }, setItem: () => { throw new Error('storage is off'); } };
  assert.deepEqual(readSeen(off, 'david'), {});
  assert.doesNotThrow(() => writeSeen(off, 'david', seen));
});

test('two windows on two rooms share one list of what was seen, and never undo each other', () => {
  // Both windows belong to the same browser, so they write the same entry. Window A has main open,
  // window B has calm open. Each only ever moves its own room, from what is stored at that moment.
  const s = storage();
  markSeen(s, 'david', 'main', 10); // A
  markSeen(s, 'david', 'calm', 5); // B
  markSeen(s, 'david', 'calm', 20); // B reads on
  markSeen(s, 'david', 'main', 11); // A reads on: it must not put calm back to what A last knew
  assert.deepEqual(readSeen(s, 'david'), { main: 11, calm: 20 });
  markSeen(s, 'david', 'main', 3); // an older message arriving late moves nothing
  assert.deepEqual(readSeen(s, 'david'), { main: 11, calm: 20 });
  const writes: string[] = [];
  const counting = { ...s, setItem: (k: string, v: string) => { writes.push(k); s.setItem(k, v); } };
  markSeen(counting, 'david', 'main', 11);
  assert.deepEqual(writes, [], 'nothing new, nothing written: the other window gets no storage event for it');
  // Nothing about which room is open is stored anywhere: only this list, the token and the drafts.
  assert.deepEqual([...s.kept.keys()], [seenKey('david')]);

  // What a window compares to know whether its stream's counts still fit: everything but its own room.
  assert.deepEqual(seenElsewhere({ main: 11, calm: 20, dev: 3 }, 'main'), { calm: 20, dev: 3 });
  assert.deepEqual(seenElsewhere({ main: 11 }, 'main'), {});
});

test('a tab shows no count for a room this browser has seen to its end, whoever did the seeing', () => {
  const list = [room('main', 'Main', 0), { ...room('calm', 'Calm talk', 2), last_id: 20 }, { ...room('dev', 'Dev', 4), last_id: 30 }];
  // The other window has calm open and has seen #20. The count of 2 was worked out a moment before that.
  const shown = withSeenApplied(list, { main: 11, calm: 20, dev: 25 });
  assert.deepEqual(shown.map((r) => [r.id, r.unread]), [['main', 0], ['calm', 0], ['dev', 4]]);
  assert.equal(shown[2], list[2], 'a room with news that nobody has seen is left as it came');
  assert.deepEqual(withSeenApplied(list, {}).map((r) => r.unread), [0, 2, 4], 'nothing seen: the counts as they came');
});

test('a count that goes up waits a moment; one that goes down, a new room and a new name are shown at once', () => {
  const counts = (list: Room[]) => list.map((r) => [r.id, r.unread]);
  const shown = [room('main', 'Main', 0), room('calm', 'Calm talk', 2), room('dev', 'Dev', 5)];
  const list = [room('main', 'Main', 1), room('calm', 'Calm talk', 0), room('dev', 'Dev renamed', 7), room('new', 'New', 3)];
  const now = heldBack(shown, list);
  assert.deepEqual(counts(now), [['main', 0], ['calm', 0], ['dev', 5], ['new', 0]], 'nothing goes up yet; calm goes down at once');
  assert.deepEqual(now.map((r) => r.name), ['Main', 'Calm talk', 'Dev renamed', 'New'], 'the rest of the list is shown as it came');
  // The moment has passed and nothing newer arrived: the list as it came.
  assert.deepEqual(counts(settled(now, list, list)), counts(list));
  // Meanwhile another window read main and dev (a newer list says 0 and 5): the count never showed.
  const newer = [room('main', 'Main', 0), room('calm', 'Calm talk', 0), room('dev', 'Dev renamed', 5), room('new', 'New', 4)];
  const afterNewer = heldBack(now, newer);
  assert.deepEqual(counts(settled(afterNewer, list, newer)), [['main', 0], ['calm', 0], ['dev', 5], ['new', 3]], 'what the older list said counts only as far as the newest still says it');
  assert.deepEqual(counts(settled(settled(afterNewer, list, newer), newer, newer)), counts(newer), 'and the newest list settles in its own time');
  // A list without counts (the caller said nothing about what it has seen) passes through.
  const plain = [room('main', 'Main'), room('calm', 'Calm talk')];
  assert.deepEqual(heldBack(shown, plain), plain);
  assert.deepEqual(settled(shown, plain, plain), plain);
});

test('each room has its own draft, and the draft of main is where it always was', () => {
  assert.equal(draftScope('david', 'main'), 'david');
  assert.equal(draftKey(draftScope('david', 'main')), 'trialogDraft:david', 'a draft from before rooms is still found');
  assert.equal(draftKey(draftScope('david', 'calm')), 'trialogDraft:david:calm');
  const s = storage({ 'trialogDraft:david': 'typed before rooms existed' });
  assert.equal(readDraft(s, draftScope('david', 'main')).text, 'typed before rooms existed');
  assert.equal(readDraft(s, draftScope('david', 'calm')).text, '', 'another room starts empty');
  const quote = { author: 'Grok', messageId: 7, kind: 'selection' as const, text: 'this part' };
  writeDraft(s, draftScope('david', 'calm'), { text: 'for calm', quotes: [quote] });
  assert.equal(readDraft(s, draftScope('david', 'main')).text, 'typed before rooms existed', 'writing one room leaves the other alone');
  assert.deepEqual(readDraft(s, draftScope('david', 'calm')), { text: 'for calm', quotes: [quote] }, 'the quotes are part of the room\'s draft');
  assert.equal(readDraft(s, draftScope('ana', 'calm')).text, '', 'and it is still per participant');
});

test('the count on a tab, and what a screen reader hears', () => {
  assert.equal(unreadLabel(undefined), '');
  assert.equal(unreadLabel(0), '');
  assert.equal(unreadLabel(1), '1');
  assert.equal(unreadLabel(99), '99');
  assert.equal(unreadLabel(100), '99+');
  assert.equal(tabLabel(ROOMS[0], true), 'Main, the room that is open');
  assert.equal(tabLabel(ROOMS[1], false), 'Calm talk');
  assert.equal(tabLabel(room('x', 'X', 1), false), 'X, 1 new message');
  assert.equal(tabLabel(ROOMS[2], false), 'Dev, more than 99 new messages');
});

test('a name for a new room is checked before anything is sent', () => {
  assert.equal(roomNameProblem('', ROOMS), '', 'nothing typed yet is not a mistake');
  assert.equal(roomNameProblem('Planning', ROOMS), '');
  assert.match(roomNameProblem('x'.repeat(41), ROOMS), /at most 40 characters/);
  assert.match(roomNameProblem('2026', ROOMS), /at least one letter/);
  assert.match(roomNameProblem('Calm', []), /^$/);
  assert.match(roomNameProblem('calm talk', [room('calm-talk', 'Calm talk')]), /a room "calm-talk" already/);
  assert.match(roomNameProblem('All', ROOMS), /"all" can't be the id of a room/);
});

test('the tabs: the open room is marked and has no count, the others show what is new', () => {
  const html = renderToStaticMarkup(<RoomTabs rooms={ROOMS} current="main" onPick={noop} onCreate={never} className="flex" />);
  assert.match(html, /^<div data-tour="rooms" class="relative[^"]* flex"><nav aria-label="Rooms"/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /<button type="button" aria-current="page" aria-label="Main, the room that is open"/);
  // Main has 3 unread in the data, but it is the room that is open: no count on it.
  const tabs = html.split('<button').slice(1);
  assert.equal(tabs.length, 4, 'three rooms and the "+"');
  assert.ok(!/rounded-full/.test(tabs[0]), 'no count on the open room');
  assert.ok(!/rounded-full/.test(tabs[1]), 'no count where nothing is new');
  assert.match(tabs[2], /aria-label="Dev, more than 99 new messages"/);
  assert.match(tabs[2], /rounded-full[^>]*>99\+<\/span>/);
  assert.match(tabs[3], /aria-label="New room" aria-expanded="false"[^>]*>\+<\/button>/);
  assert.ok(html.indexOf('</nav>') < html.indexOf('aria-label="New room"'), 'the "+" stands outside the strip that scrolls');
  assert.match(html, /overflow-x-auto/, 'the row scrolls sideways when the tabs do not fit');

  const calm = renderToStaticMarkup(<RoomTabs rooms={ROOMS} current="calm" onPick={noop} onCreate={never} />);
  assert.match(calm, /aria-label="Main, 3 new messages"/);
  assert.match(calm, /aria-current="page" aria-label="Calm talk, the room that is open"/);
  // A hub with one room shows that room and the "+".
  const one = renderToStaticMarkup(<RoomTabs rooms={[room('main', 'Main')]} current="main" onPick={noop} onCreate={never} />);
  assert.equal(one.split('<button').length - 1, 2);
  // When the hub is full, the "+" says so and can't be pressed.
  const full = renderToStaticMarkup(<RoomTabs rooms={ROOMS} current="main" onPick={noop} onCreate={never} canCreate={false} />);
  assert.match(full, /<button type="button" disabled="" aria-label="New room" aria-expanded="false" title="This hub has all the rooms it can have\."/);
});

test('a room name is shown as text, whatever it contains', () => {
  const html = renderToStaticMarkup(<RoomTabs rooms={[room('x', '<img src=x onerror=alert(1)>')]} current="main" onPick={noop} onCreate={never} />);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('a search result says which room it is in, once the hub has more than one', () => {
  const m = (id: number, inRoom: string): Message => ({ id, sender: 'grok', recipient: null, text: 'zebra', created_at: '2026-11-20T09:30:00.000Z', pinned_at: null, room: inRoom, attachments: [], reply_to: null, poll: null, reactions: [] });
  const render = (rooms?: Room[]) => renderToStaticMarkup(
    <SearchResults listId="s" results={[m(2, 'calm'), m(1, 'main'), m(3, 'gone')]} words={['zebra']} active={0} onPick={noop} participants={[]} rooms={rooms} />);
  const many = render(ROOMS);
  assert.match(many, /<span>#2<\/span><span>in Calm talk<\/span>/);
  assert.match(many, /<span>#1<\/span><span>in Main<\/span>/);
  assert.match(many, /<span>#3<\/span><span>in gone<\/span>/, 'a room the page does not know yet is named by its id');
  assert.ok(!render([room('main', 'Main')]).includes('>in '), 'with one room the list reads as before');
  assert.ok(!render().includes('>in '));
});
