// Rooms: more than one stream in one hub. The rules, both stores, a database from before rooms,
// the API, the live stream and the wake-up webhook.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  MAX_ROOMS, cleanRoomName, formatSeen, parseRoomId, parseRoomInput, parseSeen, roomIdFromName, toMarkdown,
  type Message, type Room,
} from '../lib/core';
import { UNSEEN_AFTER_MS, unseenByAgents, type Participant, type ReadPosition } from '../lib/shared';
import { createSseParser, type SseEvent } from '../lib/sse';
import { ReplyTargetError, RoomError, createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { createEventStream } from '../lib/stream';
import { createWakeup, sign, type WakeupPayload } from '../lib/webhook';

const must = <T>(v: T | null | undefined): T => { assert.ok(v, 'expected a value'); return v; };
const ids = (list: Message[]) => list.map((m) => m.id);

// --- the rules ----------------------------------------------------------------------------------

test('a room id is made from the name, and is empty when the name has nothing to make it from', () => {
  assert.equal(roomIdFromName('Calm talk'), 'calm-talk');
  assert.equal(roomIdFromName('  Büro 2 — Planung!  '), 'buro-2-planung');
  assert.equal(roomIdFromName('2026 plans'), 'plans', 'an id starts with a letter');
  assert.equal(roomIdFromName('A'.repeat(40)), 'a'.repeat(24), 'at most 24 characters');
  assert.equal(roomIdFromName('twenty-three characters-x and more'), 'twenty-three-characters', 'no hyphen left at the cut');
  assert.equal(roomIdFromName('123'), '');
  assert.equal(roomIdFromName('🎉'), '');
});

test('a room name is one line of plain text, 1 to 40 characters', () => {
  assert.equal(cleanRoomName('  Calm\ttalk \n'), 'Calm talk');
  assert.equal(cleanRoomName('x'.repeat(40)), 'x'.repeat(40));
  for (const bad of ['', '   ', 'x'.repeat(41), 'bell\x07', 42, null, undefined, ['a']]) assert.equal(cleanRoomName(bad), null, JSON.stringify(bad));
});

test('parseRoomInput: the id is optional, must have the shape of one, and "all" is kept free', () => {
  assert.deepEqual(parseRoomInput({ name: ' Calm talk ' }), { ok: true, id: 'calm-talk', name: 'Calm talk' });
  assert.deepEqual(parseRoomInput({ name: 'Calm talk', id: 'calm', created_by: 'someone-else' }), { ok: true, id: 'calm', name: 'Calm talk' });
  for (const body of [null, [], 'x', {}, { name: '' }, { name: 'x'.repeat(41) }, { name: '123' }, { name: 'ok', id: 'Not Ok' }, { name: 'ok', id: 7 }, { name: 'ok', id: 'x'.repeat(25) }, { name: 'ok', id: 'all' }, { name: 'All' }]) {
    const parsed = parseRoomInput(body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
    if (!parsed.ok) assert.equal(parsed.status, 400);
  }
});

test('parseRoomId and the "seen" list', () => {
  assert.equal(parseRoomId(undefined), null);
  assert.equal(parseRoomId(''), null);
  assert.equal(parseRoomId('calm-2'), 'calm-2');
  for (const bad of ['Calm', 'a b', '9lives', 'x'.repeat(25), 7, {}]) assert.equal(parseRoomId(bad), undefined, JSON.stringify(bad));

  assert.deepEqual(parseSeen('main:120,calm:45'), { main: 120, calm: 45 });
  assert.deepEqual(parseSeen(''), {});
  for (const bad of ['main', 'main:', 'main:-1', 'Main:1', 'main:1;calm:2', 'main:1.5', Array(30).fill('a:1').join(',')]) assert.equal(parseSeen(bad), null, bad);
  assert.equal(formatSeen({ main: 120, calm: 45 }), 'main:120,calm:45');
  assert.deepEqual(parseSeen(formatSeen({ main: 3, 'calm-2': 0 })), { main: 3, 'calm-2': 0 });
});

// --- both stores --------------------------------------------------------------------------------

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];

for (const [name, make] of STORES) {
  test(`${name}: main always exists, and a hub without other rooms behaves as before`, async () => {
    const store = await make();
    await store.ensure();
    const rooms = await store.listRooms();
    assert.deepEqual(rooms.map((r) => [r.id, r.name, r.created_by, r.last_id]), [['main', 'Main', 'hub', 1]]);
    assert.ok(!('unread' in rooms[0]), 'no count unless the caller says what they have seen');
    const m = must(await store.add({ sender: 'david', recipient: null, text: 'as always' }));
    assert.equal(m.room, 'main');
    assert.deepEqual(ids(await store.list()), [1, m.id]);
    assert.deepEqual(ids(await store.list({ room: 'main' })), [1, m.id]);
    assert.equal((await store.list())[0].room, 'main', 'the welcome message is in main');
    assert.equal((await store.getRoom('main'))?.last_id, m.id);
    assert.equal(await store.getRoom('nowhere'), null);
  });

  test(`${name}: creating rooms, an id that is taken, and the limit`, async () => {
    const store = await make();
    const calm = await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    assert.deepEqual([calm.id, calm.name, calm.created_by, calm.last_id], ['calm', 'Calm talk', 'david', 0]);
    assert.ok(!Number.isNaN(Date.parse(calm.created_at)));
    await assert.rejects(store.createRoom({ id: 'calm', name: 'Again', created_by: 'grok' }), (e: unknown) => e instanceof RoomError && e.reason === 'exists');
    await assert.rejects(store.createRoom({ id: 'main', name: 'Mine', created_by: 'grok' }), (e: unknown) => e instanceof RoomError && e.reason === 'exists');
    await assert.rejects(store.createRoom({ id: 'Not An Id', name: 'x', created_by: 'grok' }));
    await assert.rejects(store.createRoom({ id: 'long-name', name: 'x'.repeat(41), created_by: 'grok' }));
    for (let i = 3; i <= MAX_ROOMS; i++) await store.createRoom({ id: `room-${i}`, name: `Room ${i}`, created_by: 'claude' });
    assert.equal((await store.listRooms()).length, MAX_ROOMS);
    await assert.rejects(store.createRoom({ id: 'one-too-many', name: 'x', created_by: 'grok' }), (e: unknown) => e instanceof RoomError && e.reason === 'full');
    // main first, then in the order they were created.
    assert.deepEqual((await store.listRooms()).map((r) => r.id).slice(0, 3), ['main', 'calm', 'room-3']);
    assert.equal((await store.listRooms()).length, MAX_ROOMS, 'the refused ones left nothing behind');
  });

  test(`${name}: a message is in one room, ids stay global and in order, and each room lists its own`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const a = must(await store.add({ sender: 'grok', recipient: null, text: 'fast one' }));
    const b = must(await store.add({ sender: 'david', recipient: 'claude', text: 'calm one', room: 'calm' }));
    const c = must(await store.add({ sender: 'claude', recipient: null, text: 'fast two', room: 'main' }));
    const d = must(await store.add({ sender: 'claude', recipient: 'david', text: 'calm two', room: 'calm', pinned: true }));
    assert.deepEqual([a.room, b.room, c.room, d.room], ['main', 'calm', 'main', 'calm']);
    assert.deepEqual([a.id, b.id, c.id, d.id], [a.id, a.id + 1, a.id + 2, a.id + 3], 'one sequence of ids for all rooms');

    assert.deepEqual(ids(await store.list({ room: 'main' })), [1, a.id, c.id]);
    assert.deepEqual(ids(await store.list({ room: 'calm' })), [b.id, d.id]);
    assert.deepEqual(ids(await store.list()), [1, a.id, b.id, c.id, d.id], 'no room named: every room');
    // since= works per room and across rooms, because the ids are global.
    assert.deepEqual(ids(await store.list({ room: 'calm', since: b.id })), [d.id]);
    assert.deepEqual(ids(await store.list({ room: 'main', since: b.id })), [c.id]);
    assert.deepEqual(ids(await store.list({ since: a.id })), [b.id, c.id, d.id]);
    assert.deepEqual(ids(await store.list({ room: 'calm', to: 'david' })), [d.id]);
    assert.deepEqual(ids(await store.list({ room: 'calm', limit: 1 })), [d.id], 'the latest of that room');

    assert.deepEqual(ids(await store.pinned('calm')), [d.id]);
    assert.deepEqual(ids(await store.pinned('main')), []);
    assert.deepEqual(ids(await store.pinned()), [d.id]);
    assert.deepEqual(ids(await store.all('calm')), [b.id, d.id]);
    assert.equal((await store.all()).length, 5);
    assert.equal((await store.setPinned(c.id, true))?.room, 'main', 'pinning keeps the room');
    assert.deepEqual(ids(await store.pinned('main')), [c.id]);

    await assert.rejects(store.add({ sender: 'grok', recipient: null, text: 'into the void', room: 'nowhere' }), (e: unknown) => e instanceof RoomError && e.reason === 'not found');
    assert.equal((await store.all()).length, 5, 'nothing was stored');
  });

  test(`${name}: a reply stays in the room of the message it answers`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const inMain = must(await store.add({ sender: 'grok', recipient: null, text: 'in main' }));
    const inCalm = must(await store.add({ sender: 'david', recipient: null, text: 'in calm', room: 'calm' }));

    // Without a room, a reply goes where the message is. So a client from before rooms answers in the right place.
    const follows = must(await store.add({ sender: 'claude', recipient: null, text: 'answer', reply_to: inCalm.id }));
    assert.equal(follows.room, 'calm');
    assert.equal(must(await store.add({ sender: 'claude', recipient: null, text: 'answer', reply_to: inCalm.id, room: 'calm' })).room, 'calm');
    assert.equal(must(await store.add({ sender: 'claude', recipient: null, text: 'answer', reply_to: inMain.id })).room, 'main');

    const before = (await store.all()).length;
    await assert.rejects(
      store.add({ sender: 'claude', recipient: null, text: 'across', reply_to: inCalm.id, room: 'main' }),
      (e: unknown) => e instanceof RoomError && e.reason === 'other room' && /#\d+ is in the room "calm".*can't go to the room "main"/.test(e.message),
    );
    await assert.rejects(store.add({ sender: 'claude', recipient: null, text: 'across', reply_to: inMain.id, room: 'calm' }), RoomError);
    await assert.rejects(store.add({ sender: 'claude', recipient: null, text: 'to nothing', reply_to: 999_999, room: 'calm' }), ReplyTargetError);
    assert.equal((await store.all()).length, before, 'none of them was stored');
  });

  test(`${name}: search looks in every room and says where each hit is, or in one room`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const a = must(await store.add({ sender: 'grok', recipient: null, text: 'the storage question' }));
    const b = must(await store.add({ sender: 'david', recipient: null, text: 'DECISION: storage is the database', room: 'calm', pinned: true }));
    const found = await store.search({ words: ['storage'] });
    assert.deepEqual(found.map((m) => [m.id, m.room]), [[b.id, 'calm'], [a.id, 'main']], 'newest first, each with its room');
    assert.deepEqual(ids(await store.search({ words: ['storage'], room: 'main' })), [a.id]);
    assert.deepEqual(ids(await store.search({ words: ['storage'], room: 'calm' })), [b.id]);
    assert.deepEqual(ids(await store.search({ words: ['storage'], pinned: true })), [b.id]);
    assert.deepEqual(ids(await store.search({ words: ['storage'], pinned: true, room: 'main' })), []);
  });

  test(`${name}: the fingerprint follows one room, and the rooms list counts what a caller has not seen`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const a = must(await store.add({ sender: 'grok', recipient: null, text: 'one' }));
    const mainBefore = await store.version('main');
    assert.equal((await store.version('calm')).last_id, 0, 'an empty room');
    const b = must(await store.add({ sender: 'grok', recipient: null, text: 'two', room: 'calm', pinned: true }));
    const c = must(await store.add({ sender: 'david', recipient: null, text: 'three', room: 'calm' }));
    const main = await store.version('main');
    assert.equal(main.last_id, a.id, 'a message in another room does not move this room on');
    assert.equal(main.pins, mainBefore.pins);
    assert.notEqual(main.rooms, mainBefore.rooms, 'but the rooms fingerprint says another room has news');
    assert.equal(main.rooms, `calm:${c.id},main:${a.id}`);
    const calm = await store.version('calm');
    assert.deepEqual([calm.last_id, calm.pins], [c.id, String(b.id)]);
    assert.equal((await store.version()).last_id, c.id, 'no room named: the newest of all');

    const rooms = await store.listRooms({ seen: { main: a.id, calm: 0 }, me: 'david' });
    assert.deepEqual(rooms.map((r) => [r.id, r.last_id, r.unread]), [['main', a.id, 0], ['calm', c.id, 1]], "the caller's own message is not unread");
    assert.deepEqual((await store.listRooms({ seen: {}, me: 'claude' })).map((r) => r.unread), [2, 2], 'a room that is not named counts from the start');
    assert.deepEqual((await store.listRooms({ seen: { main: a.id, calm: c.id }, me: 'claude' })).map((r) => r.unread), [0, 0]);
    assert.deepEqual((await store.listRooms({ seen: { nowhere: 5 } })).map((r) => r.unread), [2, 2], 'an unknown room in the list is ignored');
  });

  test(`${name}: a poll and a decision card live in their room, and so do the messages they write`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const poll = must(await store.createPoll({ creator: 'david', question: 'Lunch?', options: ['Yes', 'No'], room: 'calm' }));
    assert.equal(poll.message.room, 'calm');
    assert.equal(must(await store.createPoll({ creator: 'david', question: 'Main?', options: ['Yes', 'No'] })).message.room, 'main');
    await store.vote(poll.poll.id, 'grok', 1);
    const closed = must(await store.closePoll(poll.poll.id, 'david'));
    assert.equal(closed.message?.room, 'calm', 'the result is posted where the poll is');
    assert.equal(closed.message?.reply_to, poll.message.id);
    await assert.rejects(store.createPoll({ creator: 'david', question: 'Where?', options: ['A', 'B'], room: 'nowhere' }), RoomError);

    const roster = ['grok', 'claude', 'david'];
    const card = must(await store.createDecision({ creator: 'claude', prompt: 'Ship it?', room: 'calm' }, roster));
    assert.equal(card.message.room, 'calm');
    const position = await store.recordDecisionPosition(card.decision.id, 'grok', 'object', 'not yet', roster);
    assert.equal(position.status, 'ok');
    if (position.status === 'ok') assert.equal(position.reply?.room, 'calm', 'the note is posted where the card is');
    // A card that answers a message follows it, like any reply.
    const follows = must(await store.createDecision({ creator: 'grok', prompt: 'And this?', reply_to: card.message.id }, roster));
    assert.equal(follows.message.room, 'calm');
    await assert.rejects(store.createDecision({ creator: 'grok', prompt: 'Across?', reply_to: card.message.id, room: 'main' }, roster), RoomError);

    // A reaction is on a message, so it is in that message's room too.
    const reacted = await store.addReaction(poll.message.id, 'claude', '👍');
    assert.equal(reacted.status === 'ok' && reacted.message.room, 'calm');
    assert.ok((await store.list({ room: 'main' })).every((m) => m.room === 'main'));
  });

  test(`${name}: wake-ups work the same in every room, and the list keeps to the room that was asked for`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const who = { participant: 'grok', limit: 50, humans: ['david'], agents: ['grok', 'claude'] };
    const a = must(await store.add({ sender: 'david', recipient: 'claude', text: 'the human, in main' }));
    const b = must(await store.add({ sender: 'david', recipient: null, text: 'the human, in calm', room: 'calm' }));
    const c = must(await store.add({ sender: 'claude', recipient: 'grok', text: 'an agent to grok, in calm', room: 'calm' }));
    must(await store.add({ sender: 'claude', recipient: 'david', text: 'an agent to the human, in calm', room: 'calm' }));
    const d = must(await store.add({ sender: 'claude', recipient: null, text: 'an agent to everyone, in main' }));
    // The rule does not look at the room: a human wakes every agent, an agent only those it addresses.
    assert.deepEqual(ids(await store.listWakingMessages({ ...who, since: 0 })), [a.id, b.id, c.id, d.id], 'no room named: every room');
    assert.deepEqual(ids(await store.listWakingMessages({ ...who, since: 0, room: 'main' })), [a.id, d.id]);
    assert.deepEqual(ids(await store.listWakingMessages({ ...who, since: 0, room: 'calm' })), [b.id, c.id]);
    assert.deepEqual(ids(await store.listWakingMessages({ ...who, since: b.id, room: 'calm' })), [c.id]);
    assert.deepEqual(ids(await store.listWakingMessages({ ...who, since: null, room: 'calm' })), [b.id, c.id], 'the latest of that room');
    // A wake-up that waits to be sent knows the room of its message.
    await store.enqueueWakes(b.id, ['grok']);
    await store.enqueueWakes(d.id, ['grok']);
    assert.deepEqual((await store.listPendingWakes()).map((w) => [w.message_id, w.participant, w.room]), [[b.id, 'grok', 'calm'], [d.id, 'grok', 'main']]);
    assert.deepEqual((await store.claimPendingWakes()).map((w) => [w.message_id, w.room]), [[b.id, 'calm'], [d.id, 'main']]);
  });
}


for (const [name, make] of STORES) {
  test(`${name}: the lists of polls, reactions and decision cards are those of one room`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const roster = ['grok', 'claude', 'david'];
    const pollMain = must(await store.createPoll({ creator: 'david', question: 'Main poll?', options: ['A', 'B'] }));
    const pollCalm = must(await store.createPoll({ creator: 'david', question: 'Calm poll?', options: ['A', 'B'], room: 'calm' }));
    const cardMain = must(await store.createDecision({ creator: 'claude', prompt: 'Main card?' }, roster));
    const cardCalm = must(await store.createDecision({ creator: 'claude', prompt: 'Calm card?', room: 'calm' }, roster));
    await store.addReaction(pollMain.message.id, 'grok', '👍');
    await store.addReaction(pollCalm.message.id, 'grok', '🎉');

    assert.deepEqual((await store.listPolls('calm')).map((p) => p.id), [pollCalm.poll.id]);
    assert.deepEqual((await store.listPolls('main')).map((p) => p.id), [pollMain.poll.id]);
    assert.deepEqual((await store.listPolls()).map((p) => p.id).sort(), [pollMain.poll.id, pollCalm.poll.id].sort(), 'no room named: every room');
    assert.deepEqual((await store.listReactions('calm')).map((r) => r.message_id), [pollCalm.message.id]);
    assert.deepEqual((await store.listReactions('main')).map((r) => r.message_id), [pollMain.message.id]);
    assert.deepEqual((await store.listReactions()).map((r) => r.message_id), [pollMain.message.id, pollCalm.message.id]);
    assert.deepEqual((await store.listDecisions('calm')).map((c) => c.id), [cardCalm.decision.id]);
    assert.deepEqual((await store.listDecisions('main')).map((c) => c.id), [cardMain.decision.id]);
    assert.deepEqual((await store.listDecisions()).map((c) => c.id).sort(), [cardMain.decision.id, cardCalm.decision.id].sort());
    assert.deepEqual(await store.listPolls('third'), [], 'a room without any');
  });

  test(`${name}: an image belongs to its message, and so to that message's room`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const upload = must(await store.addAttachment({ sender: 'david', content_type: 'image/png', width: 2, height: 1, data: Buffer.from('not-a-real-image') }));
    const m = must(await store.add({ sender: 'david', recipient: null, text: 'a picture in calm', room: 'calm', attachments: [upload.id] }));
    assert.deepEqual([m.room, m.attachments.map((a) => a.id)], ['calm', [upload.id]]);
    assert.deepEqual((await store.list({ room: 'calm' })).at(-1)?.attachments.map((a) => a.id), [upload.id]);
    assert.ok((await store.list({ room: 'main' })).every((x) => x.attachments.length === 0), 'main shows no image of another room');
    assert.equal((await store.getAttachment(upload.id))?.attachment.message_id, m.id, 'the image itself is fetched by its id, with a token, whatever room it is in');
    // An upload can be linked once: not to a second message in another room.
    await assert.rejects(store.add({ sender: 'david', recipient: null, text: 'again, in main', attachments: [upload.id] }));
  });
}

// --- read positions, per room -------------------------------------------------------------------

for (const [name, make] of STORES) {
  test(`${name}: a read position is per participant and room, and reading one room says nothing about another`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const m1 = must(await store.add({ sender: 'david', recipient: null, text: 'main, early' }));
    const c1 = must(await store.add({ sender: 'david', recipient: null, text: 'calm, early', room: 'calm' }));
    const m2 = must(await store.add({ sender: 'david', recipient: null, text: 'main, late' }));
    const c2 = must(await store.add({ sender: 'david', recipient: null, text: 'calm, late', room: 'calm' }));

    // Grok reads calm to its end. The id is higher than everything in main, and main is still unread.
    const inCalm = await store.setReadPosition('grok', c2.id);
    assert.deepEqual([inCalm.participant, inCalm.room, inCalm.up_to], ['grok', 'calm', c2.id]);
    assert.deepEqual(await store.listReads('main'), [], 'nothing was read in main');
    assert.deepEqual((await store.listReads('calm')).map((r) => [r.participant, r.room, r.up_to]), [['grok', 'calm', c2.id]]);

    // Then the first message of main: a lower id than the calm position, and it counts, because it is another room.
    const inMain = await store.setReadPosition('grok', m1.id);
    assert.deepEqual([inMain.room, inMain.up_to], ['main', m1.id]);
    assert.deepEqual((await store.listReads()).map((r) => [r.participant, r.room, r.up_to]), [['grok', 'calm', c2.id], ['grok', 'main', m1.id]]);
    // Only forward, within a room.
    assert.equal((await store.setReadPosition('grok', c1.id)).up_to, c2.id);
    assert.equal((await store.setReadPosition('grok', m2.id)).up_to, m2.id);
    await store.setReadPosition('claude', c1.id);
    assert.deepEqual((await store.listReads('calm')).map((r) => [r.participant, r.up_to]), [['claude', c1.id], ['grok', c2.id]]);

    // The room may be named, and must then be the room the message is in.
    assert.equal((await store.setReadPosition('claude', c2.id, 'calm')).room, 'calm');
    await assert.rejects(store.setReadPosition('claude', m2.id, 'calm'), (e: unknown) => e instanceof RoomError && e.reason === 'read elsewhere');
    assert.deepEqual((await store.listReads('main')).map((r) => r.participant), ['grok'], 'the refused one recorded nothing');

    // The fingerprint of a room moves with that room's positions only.
    const calmBefore = (await store.version('calm')).reads;
    const mainBefore = (await store.version('main')).reads;
    assert.equal(mainBefore, `1|grok:${m2.id}`);
    await store.setReadPosition('david', c2.id);
    assert.notEqual((await store.version('calm')).reads, calmBefore);
    assert.equal((await store.version('main')).reads, mainBefore);
  });

  test(`${name}: the «not seen yet» flag is worked out within a room`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const question = must(await store.add({ sender: 'david', recipient: 'grok', text: '@grok a calm question', room: 'calm' }));
    const later = must(await store.add({ sender: 'claude', recipient: null, text: 'fast work in main' }));
    // Grok reads main, past the id of the question it was asked in the other room.
    await store.setReadPosition('grok', later.id);
    const roster: Participant[] = [{ name: 'grok', kind: 'agent', color: 0 }, { name: 'claude', kind: 'agent', color: 1 }, { name: 'david', kind: 'human', color: 2 }];
    const afterAWhile = Date.parse(question.created_at) + UNSEEN_AFTER_MS + 1000;
    assert.equal(unseenByAgents(question, await store.listReads('calm'), roster, afterAWhile), true, 'the question in calm is still not seen');
    await store.setReadPosition('grok', question.id);
    assert.equal(unseenByAgents(question, await store.listReads('calm'), roster, afterAWhile), false);
  });

  test(`${name}: the stream sends the read positions of its room only`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const m = must(await store.add({ sender: 'david', recipient: null, text: 'in main' }));
    const c = must(await store.add({ sender: 'david', recipient: null, text: 'in calm', room: 'calm' }));
    await store.setReadPosition('grok', m.id);
    const abort = new AbortController();
    const r = reader(createEventStream({ store, me: 'david', since: c.id, room: 'calm', signal: abort.signal, ...FAST }));
    const [, , reads] = await r.next(4); // hello, pins, reads, rooms
    assert.deepEqual(reads, { event: 'reads', data: [] }, 'what was read in main is not sent to calm');
    await store.setReadPosition('claude', m.id);
    assert.ok(await r.quiet(120), 'a position that moves in main is not sent either');
    await store.setReadPosition('grok', c.id);
    const [moved] = await r.next();
    assert.equal(moved.event, 'reads');
    assert.deepEqual((moved.data as ReadPosition[]).map((p) => [p.participant, p.room, p.up_to]), [['grok', 'calm', c.id]]);
    abort.abort();
    await r.finished();
  });
}

// --- a database from before rooms ---------------------------------------------------------------

const file = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

/** A database as the application left it before rooms: the schema of that time, and some history. */
async function databaseBeforeRooms(): Promise<PGlite> {
  const pg = new PGlite();
  for (const name of ['../schema.sql']) {
    // Everything in today's schema up to the rooms part, which starts with the rooms table.
    const sql = await file(name);
    const at = sql.indexOf('CREATE TABLE IF NOT EXISTS rooms');
    assert.ok(at > 0, 'schema.sql has a rooms part to cut off');
    await pg.exec(sql.slice(0, at));
  }
  await pg.exec(`
    INSERT INTO messages (sender, recipient, text, created_at, pinned_at) VALUES
      ('hub', NULL, 'the welcome text of that time', '2026-11-25T10:00:00Z', NULL),
      ('david', NULL, 'hello both', '2026-11-25T10:01:00Z', NULL),
      ('grok', 'claude', '@claude please review', '2026-11-25T10:02:00Z', NULL),
      ('claude', 'david', 'DECISION: we keep it simple', '2026-11-25T10:03:00Z', '2026-11-25T10:03:00Z');
    UPDATE messages SET reply_to = 3 WHERE id = 4;
    UPDATE webhook_state SET last_notified_id = 4;
    INSERT INTO read_positions (participant, up_to, updated_at) VALUES ('grok', 3, '2026-11-25T10:05:00Z'), ('david', 4, '2026-11-25T10:06:00Z');`);
  return pg;
}
const columns = async (pg: PGlite, table: string) =>
  (await pg.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.c);
const tables = async (pg: PGlite) =>
  (await pg.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`)).rows.map((r) => r.t);
/** Every message as it was stored, without the room. */
const history = async (pg: PGlite) => JSON.stringify((await pg.query(`SELECT (to_jsonb(m) - 'room')::text AS row FROM messages m ORDER BY id`)).rows);

test('the fixture really is a database from before rooms', async () => {
  const pg = await databaseBeforeRooms();
  assert.ok(!(await tables(pg)).includes('rooms'));
  assert.ok(!(await columns(pg, 'messages')).includes('room'));
  assert.ok((await tables(pg)).includes('decision_cards'), 'it has everything that came before');
  assert.deepEqual(await columns(pg, 'read_positions'), ['participant', 'up_to', 'updated_at'], 'read positions have no room yet');
  await assert.rejects(pg.query(`INSERT INTO read_positions (participant, up_to) VALUES ('grok', 4)`), /read_positions_pkey/, 'one position per participant');
  await pg.close();
});

test('first request on an old database: it gains the table and the column, and every old message is in main', async () => {
  const pg = await databaseBeforeRooms();
  const before = await history(pg);
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  assert.ok((await tables(pg)).includes('rooms'));
  assert.equal((await columns(pg, 'messages')).at(-1), 'room');
  assert.equal(await history(pg), before, 'no message was added, changed or removed');
  assert.deepEqual((await pg.query(`SELECT DISTINCT room FROM messages`)).rows, [{ room: 'main' }]);

  const all = await store.list();
  assert.deepEqual(all.map((m) => [m.id, m.sender, m.room]), [[1, 'hub', 'main'], [2, 'david', 'main'], [3, 'grok', 'main'], [4, 'claude', 'main']]);
  assert.equal(all[0].text, 'the welcome text of that time', 'no second welcome');
  assert.deepEqual(ids(await store.list({ room: 'main' })), [1, 2, 3, 4]);
  assert.deepEqual(ids(await store.pinned('main')), [4]);
  assert.deepEqual((await store.listRooms()).map((r) => [r.id, r.name, r.last_id]), [['main', 'Main', 4]]);
  assert.equal(await store.claimWakeup(), null, 'the old history wakes nobody');

  // The read positions of that time are the positions in main, unchanged, and a second room starts unread.
  assert.equal((await columns(pg, 'read_positions')).at(-1), 'room');
  assert.deepEqual((await store.listReads()).map((r) => [r.participant, r.room, r.up_to, r.updated_at]), [['david', 'main', 4, '2026-11-25T10:06:00.000Z'], ['grok', 'main', 3, '2026-11-25T10:05:00.000Z']]);
  assert.deepEqual((await store.listReads('main')).length, 2);
  assert.equal((await store.setReadPosition('grok', 4)).up_to, 4, 'a position from before moves on as usual');

  // The next message continues the same ids, in main, and a new room can be used at once.
  const next = must(await store.add({ sender: 'david', recipient: null, text: 'after the update', reply_to: 4 }));
  assert.deepEqual([next.id, next.room], [5, 'main']);
  await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
  assert.deepEqual([must(await store.add({ sender: 'david', recipient: null, text: 'in calm', room: 'calm' })).id], [6]);
  assert.deepEqual([(await store.setReadPosition('grok', 6)).room, (await store.listReads('main')).find((r) => r.participant === 'grok')?.up_to], ['calm', 4]);
  await pg.close();
});

test('the migration is idempotent: a second start, and the file run by hand twice, change nothing', async () => {
  const pg = await databaseBeforeRooms();
  await createSqlStore(pgliteDb(pg)).ensure();
  const store = createSqlStore(pgliteDb(pg));
  await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
  must(await store.add({ sender: 'david', recipient: null, text: 'in calm', room: 'calm' }));
  const snapshot = async () => JSON.stringify([
    (await pg.query(`SELECT m::text AS row FROM messages m ORDER BY id`)).rows,
    (await pg.query(`SELECT r::text AS row FROM rooms r ORDER BY id`)).rows,
    await columns(pg, 'messages'),
    (await pg.query(`SELECT p::text AS row FROM read_positions p ORDER BY participant, room`)).rows,
    (await pg.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'read_positions_pkey'`)).rows,
  ]);
  const before = await snapshot();
  await createSqlStore(pgliteDb(pg)).ensure(); // a second instance starts
  const migration = await file('../migrations/012-rooms.sql');
  await pg.exec(migration);
  await pg.exec(migration);
  assert.equal(await snapshot(), before, 'the room of a message and the rooms themselves are untouched');

  // Someone who applies the file to an old database themselves, without the app, gets the same.
  const byHand = await databaseBeforeRooms();
  const old = await history(byHand);
  await byHand.exec(migration);
  assert.equal(await history(byHand), old);
  assert.deepEqual(await columns(byHand, 'messages'), await columns(pg, 'messages'));
  assert.deepEqual((await byHand.query(`SELECT participant, room, up_to::int AS up_to FROM read_positions ORDER BY participant`)).rows, [{ participant: 'david', room: 'main', up_to: 4 }, { participant: 'grok', room: 'main', up_to: 3 }]);
  assert.deepEqual((await byHand.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'read_positions_pkey'`)).rows, [{ def: 'PRIMARY KEY (participant, room)' }]);
  await assert.rejects(byHand.query(`INSERT INTO read_positions (participant, room, up_to) VALUES ('grok', 'nowhere', 3)`), /read_positions_room_exists/);
  assert.deepEqual((await byHand.query(`SELECT id, name, created_by FROM rooms`)).rows, [{ id: 'main', name: 'Main', created_by: 'hub' }]);
  // The database itself refuses a message in a room that does not exist, and a room id that is not one.
  await assert.rejects(byHand.query(`INSERT INTO messages (sender, text, room) VALUES ('david', 'x', 'nowhere')`), /messages_room_exists/);
  await assert.rejects(byHand.query(`INSERT INTO rooms (id, name, created_by) VALUES ('Not An Id', 'x', 'david')`), /rooms_id_shape/);
  await assert.rejects(byHand.query(`INSERT INTO rooms (id, name, created_by) VALUES ('long', '${'x'.repeat(41)}', 'david')`), /rooms_name_length/);
  await pg.close();
  await byHand.close();
});

// --- the export ---------------------------------------------------------------------------------

test('the transcript of main reads as before; another room and all rooms say so', () => {
  const at = new Date('2026-11-26T09:00:00Z');
  const base = { recipient: null, created_at: '2026-11-25T13:00:00Z', attachments: [], reply_to: null, poll: null, reactions: [] };
  const inMain: Message = { ...base, id: 2, sender: 'grok', text: 'in main', pinned_at: null, room: 'main' };
  const inCalm: Message = { ...base, id: 3, sender: 'david', text: 'DECISION: in calm', pinned_at: '2026-11-25T13:00:00Z', room: 'calm' };
  const plain = toMarkdown([inMain], at);
  assert.equal(toMarkdown([inMain], at, { id: 'main', name: 'Main' }), plain, 'naming main changes nothing');
  assert.ok(plain.startsWith('# Trialog transcript\n'));
  assert.ok(plain.includes('**Grok** · 2026-11-25 14:00 · #2\n'));
  const calm = toMarkdown([inCalm], at, { id: 'calm', name: 'Calm talk' });
  assert.ok(calm.startsWith('# Trialog transcript: Calm talk\n'));
  assert.ok(calm.includes('**David** · 2026-11-25 14:00 · #3 · 📌\n'), 'inside one room a message does not repeat the room');
  const all = toMarkdown([inMain, inCalm], at, 'all');
  assert.ok(all.startsWith('# Trialog transcript: all rooms\n'));
  assert.ok(all.includes('- #3 (David, 2026-11-25 14:00, calm): DECISION: in calm'));
  assert.ok(all.includes('**Grok** · 2026-11-25 14:00 · #2 · main\n'));
  assert.ok(all.includes('**David** · 2026-11-25 14:00 · #3 · calm · 📌\n'));
});

// --- the live stream ----------------------------------------------------------------------------

/** Reads a stream into parsed events. `next(n)` waits until n more events have arrived. */
function reader(stream: ReadableStream<Uint8Array>) {
  const events: SseEvent[] = [];
  let done = false;
  let wake: (() => void) | undefined;
  const parser = createSseParser((e) => events.push(e));
  const r = stream.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { done: d, value } = await r.read();
      if (d) break;
      parser.push(decoder.decode(value, { stream: true }));
      wake?.();
    }
    done = true;
    wake?.();
  })();
  let taken = 0;
  return {
    async next(n = 1, timeoutMs = 3000): Promise<{ event: string; data: unknown }[]> {
      const deadline = Date.now() + timeoutMs;
      while (events.length < taken + n && !done) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} event(s); got ${JSON.stringify(events.slice(taken))}`);
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 20); });
      }
      const out = events.slice(taken, taken + n).map((e) => ({ event: e.event, data: JSON.parse(e.data) as unknown }));
      taken += out.length;
      return out;
    },
    async quiet(ms = 80): Promise<boolean> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return events.length === taken;
    },
    async finished(timeoutMs = 3000) { await Promise.race([pump, new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not end')), timeoutMs))]); },
  };
}
const FAST = { intervalMs: 10, heartbeatMs: 10_000, maxMs: 60_000 };

for (const [name, make] of STORES) {
  test(`${name}: the stream delivers its own room only, and says when another room has news`, async () => {
    const store = await make();
    await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
    const old = must(await store.add({ sender: 'grok', recipient: null, text: 'calm, before the stream', room: 'calm', pinned: true }));
    const abort = new AbortController();
    const r = reader(createEventStream({ store, me: 'david', since: null, room: 'calm', seen: { main: 1, calm: old.id }, signal: abort.signal, ...FAST }));

    const [hello, initial, pins, , rooms] = await r.next(5); // the fourth is the read positions
    assert.deepEqual(hello, { event: 'hello', data: { me: 'david', room: 'calm' } });
    assert.deepEqual(ids(initial.data as Message[]), [old.id], 'not the welcome message, which is in main');
    assert.deepEqual(ids(pins.data as Message[]), [old.id]);
    assert.deepEqual((rooms.data as Room[]).map((room) => [room.id, room.last_id, room.unread]), [['main', 1, 0], ['calm', old.id, 0]]);
    assert.ok(await r.quiet());

    // A message in this room arrives as a message, and nothing else is said.
    const here = must(await store.add({ sender: 'claude', recipient: null, text: 'calm, live', room: 'calm' }));
    assert.deepEqual(await r.next(), [{ event: 'messages', data: [here] }]);
    assert.ok(await r.quiet());

    // A message in another room is not delivered. The rooms list says that main has one more.
    const elsewhere = must(await store.add({ sender: 'grok', recipient: null, text: 'main, live' }));
    const [news] = await r.next();
    assert.equal(news.event, 'rooms');
    assert.deepEqual((news.data as Room[]).map((room) => [room.id, room.last_id, room.unread]), [['main', elsewhere.id, 1], ['calm', here.id, 1]]);
    assert.ok(await r.quiet(), 'and no messages event follows');

    // A pin, a reaction and a vote in another room stay there too.
    await store.setPinned(elsewhere.id, true);
    await store.addReaction(elsewhere.id, 'claude', '👍');
    const poll = must(await store.createPoll({ creator: 'grok', question: 'Main poll?', options: ['A', 'B'] }));
    assert.equal((await r.next())[0].event, 'rooms', 'the poll is a new message in main');
    await store.vote(poll.poll.id, 'claude', 1);
    assert.ok(await r.quiet(120), 'nothing of main reaches the stream of calm');
    // The same things in this room are pushed.
    await store.addReaction(here.id, 'grok', '👍');
    const [updated] = await r.next();
    assert.deepEqual([updated.event, ids(updated.data as Message[])], ['messages', [here.id]]);

    // A new room shows up at once.
    await store.createRoom({ id: 'third', name: 'Third', created_by: 'grok' });
    const [list] = await r.next();
    assert.deepEqual([list.event, (list.data as Room[]).map((room) => room.id)], ['rooms', ['main', 'calm', 'third']]);

    abort.abort();
    await r.finished();
  });
}

// --- the wake-up webhook ------------------------------------------------------------------------

test('a wake-up says which room its message is in, and is signed the same way', async () => {
  const store = createMemoryStore();
  await store.createRoom({ id: 'calm', name: 'Calm talk', created_by: 'david' });
  const calls: { headers: Record<string, string>; body: string }[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const secret = 'webhook-test-secret-0123456789';
  const roster: Participant[] = [{ name: 'grok', kind: 'agent', color: 0 }, { name: 'claude', kind: 'agent', color: 1 }, { name: 'david', kind: 'human', color: 2 }];
  const wakeup = createWakeup({
    store, roster, fallbackTargets: { grok: { url: 'https://receiver.test/hook', secret } }, fetch: fakeFetch,
    now: () => 1_795_620_000_000, debounceMs: 20, retryDelaysMs: [], enforcePublicTarget: false,
  });
  const inCalm = must(await store.add({ sender: 'david', recipient: null, text: 'a question in the calm room', room: 'calm' }));
  const inMain = must(await store.add({ sender: 'david', recipient: 'grok', text: 'and one in main' }));
  await Promise.all([wakeup.onMessage(inCalm), wakeup.onMessage(inMain)]);
  const payloads = calls.map((call) => JSON.parse(call.body) as WakeupPayload).sort((x, y) => x.id - y.id);
  assert.deepEqual(payloads.map((p) => [p.id, p.room]), [[inCalm.id, 'calm'], [inMain.id, 'main']], 'one request per message, each with the room of its message');
  assert.equal(typeof payloads[0].room, 'string', 'one room, not a list');
  assert.ok(!('rooms' in payloads[0]));
  assert.ok(calls.every((call) => !call.body.includes('Calm talk')), 'the id of the room, never its name');
  for (const call of calls) assert.equal(call.headers['X-Hub-Signature'], sign(secret, '1795620000', call.body), 'the signature covers the bytes as sent, the room included');
});

// --- the API ------------------------------------------------------------------------------------

const TOKENS: Record<string, string> = {
  grok: 'grok-test-token-0123456789abcdef',
  claude: 'claude-test-token-0123456789abcdef',
  david: 'david-test-token-0123456789abcdef',
};
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let messages: { GET: Handler; POST: Handler };
let roomsRoute: { GET: Handler; POST: Handler };
let exportRoute: { GET: Handler };
let pollsRoute: { POST: Handler };
let closeRoute: { POST: Handler };
let decisionsRoute: { POST: Handler };
let pinRoute: { POST: Handler };
let streamRoute: { GET: Handler };
let readRoute: { PUT: Handler };
let wakeRoute: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.PARTICIPANTS;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  roomsRoute = (await import('../app/api/rooms/route')) as unknown as typeof roomsRoute;
  exportRoute = (await import('../app/api/export/route')) as unknown as typeof exportRoute;
  pollsRoute = (await import('../app/api/polls/route')) as unknown as typeof pollsRoute;
  closeRoute = (await import('../app/api/polls/[id]/close/route')) as unknown as typeof closeRoute;
  decisionsRoute = (await import('../app/api/decisions/route')) as unknown as typeof decisionsRoute;
  pinRoute = (await import('../app/api/messages/[id]/pin/route')) as unknown as typeof pinRoute;
  streamRoute = (await import('../app/api/stream/route')) as unknown as typeof streamRoute;
  readRoute = (await import('../app/api/read/route')) as unknown as typeof readRoute;
  wakeRoute = (await import('../app/api/wake/route')) as unknown as typeof wakeRoute;
});

const URL_BASE = 'http://hub.test';
const auth = (who: string) => ({ Authorization: `Bearer ${TOKENS[who]}` });
const call = (handler: Handler, path: string, who: string, body?: unknown, ctx?: unknown) => handler(new Request(`${URL_BASE}${path}`, body === undefined
  ? { headers: auth(who) }
  : { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: JSON.stringify(body) }), ctx);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const post = (body: unknown, who: string) => call(messages.POST, '/api/messages', who, body);
const posted = async (body: unknown, who: string) => {
  const res = await post(body, who);
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { message: Message }).message;
};
const list = async (query = '', who = 'david') => {
  const res = await call(messages.GET, `/api/messages${query}`, who);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { me: string; messages: Message[]; pinned: Message[] };
};
const rooms = async (query = '', who = 'david') => ((await (await call(roomsRoute.GET, `/api/rooms${query}`, who)).json()) as { me: string; rooms: Room[] });

test('a hub with one room: every call without a room behaves exactly as before', async () => {
  const a = await posted({ text: 'plain, as before' }, 'david');
  assert.equal(a.room, 'main');
  const all = await list('?since=0');
  assert.deepEqual(Object.keys(all).sort(), ['me', 'messages', 'pinned']);
  assert.deepEqual(ids(all.messages), [1, a.id]);
  const data = await rooms();
  assert.equal(data.me, 'david');
  assert.deepEqual(data.rooms.map((r) => [r.id, r.name, r.created_by, r.last_id]), [['main', 'Main', 'hub', a.id]]);
  assert.deepEqual(Object.keys(data.rooms[0]).sort(), ['created_at', 'created_by', 'id', 'last_id', 'name']);
  assert.equal((await call(roomsRoute.GET, '/api/rooms', 'nobody')).status, 401);
});

test('POST /api/rooms: any participant creates one; a bad name or id, a taken id and "main" are refused', async () => {
  const res = await call(roomsRoute.POST, '/api/rooms', 'grok', { name: 'Calm talk', id: 'calm', created_by: 'david' });
  assert.equal(res.status, 201);
  const { room } = (await res.json()) as { room: Room };
  assert.deepEqual([room.id, room.name, room.created_by, room.last_id], ['calm', 'Calm talk', 'grok'/* from the token, never the body */, 0]);
  // Without an id, it is made from the name.
  const derived = await call(roomsRoute.POST, '/api/rooms', 'david', { name: 'Büro 2' });
  assert.equal(((await derived.json()) as { room: Room }).room.id, 'buro-2');

  assert.equal((await call(roomsRoute.POST, '/api/rooms', 'nobody', { name: 'x' })).status, 401);
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(41) }, { name: 'ok', id: 'Not Ok' }, { name: 'ok', id: 'all' }, { name: '123' }]) {
    assert.equal((await call(roomsRoute.POST, '/api/rooms', 'david', body)).status, 400, JSON.stringify(body));
  }
  const taken = await call(roomsRoute.POST, '/api/rooms', 'claude', { name: 'Another calm', id: 'calm' });
  assert.equal(taken.status, 409);
  assert.match(await errorOf(taken), /"calm" already exists/);
  assert.equal((await call(roomsRoute.POST, '/api/rooms', 'claude', { name: 'Main' })).status, 409, 'main is there already and stays as it is');
  assert.deepEqual((await rooms()).rooms.map((r) => [r.id, r.name]), [['main', 'Main'], ['calm', 'Calm talk'], ['buro-2', 'Büro 2']]);
});

test('messages go to the room that is named, and a call without one still sees only main', async () => {
  const before = await list();
  const inCalm = await posted({ text: '@claude in calm', room: 'calm' }, 'david');
  assert.deepEqual([inCalm.room, inCalm.recipient], ['calm', 'claude']);
  const inMain = await posted({ text: 'DECISION: in main' }, 'grok');

  const main = await list('?since=0');
  assert.ok(main.messages.every((m) => m.room === 'main'), 'an old client never sees another room');
  assert.deepEqual(ids(main.messages).slice(-1), [inMain.id]);
  assert.deepEqual(ids(main.pinned), [...ids(before.pinned), inMain.id]);
  assert.deepEqual(await list('?since=0&room=main'), main, 'naming main is the same as naming none');

  const calm = await list('?room=calm');
  assert.deepEqual(ids(calm.messages), [inCalm.id]);
  assert.deepEqual(calm.pinned, [], 'the pinned list is the room\'s own');
  assert.deepEqual(ids((await list(`?room=calm&since=${inCalm.id}`)).messages), []);
  assert.deepEqual(ids((await list('?room=calm&to=claude')).messages), [inCalm.id]);

  // Every room at once, for a reader who wants to hear all of it with one call.
  const all = await list(`?room=all&since=${inCalm.id - 1}`);
  assert.deepEqual(all.messages.map((m) => [m.id, m.room]), [[inCalm.id, 'calm'], [inMain.id, 'main']]);
  assert.ok(ids(all.pinned).includes(inMain.id));

  assert.equal((await call(messages.GET, '/api/messages?room=nowhere', 'david')).status, 404);
  assert.equal((await call(messages.GET, '/api/messages?room=Not%20An%20Id', 'david')).status, 400);
  const missing = await post({ text: 'x', room: 'nowhere' }, 'david');
  assert.equal(missing.status, 404);
  assert.match(await errorOf(missing), /Room "nowhere" does not exist/);
  assert.equal((await post({ text: 'x', room: 'all' }, 'david')).status, 404, 'nothing can be posted to every room');
  for (const bad of ['Calm', 7, ['calm'], { id: 'calm' }]) assert.equal((await post({ text: 'x', room: bad }, 'david')).status, 400, JSON.stringify(bad));
});

test('a reply across rooms is refused; without a room it follows the message it answers', async () => {
  const inCalm = await posted({ text: 'a question in calm', room: 'calm' }, 'david');
  const follows = await posted({ text: 'an answer from an old client', reply_to: inCalm.id }, 'claude');
  assert.equal(follows.room, 'calm');
  const across = await post({ text: 'an answer in the wrong room', reply_to: inCalm.id, room: 'main' }, 'claude');
  assert.equal(across.status, 409);
  assert.match(await errorOf(across), new RegExp(`Message #${inCalm.id} is in the room "calm"`));
  assert.ok(!ids((await list('?since=0')).messages).includes(follows.id), 'main did not get it');
});

test('search looks in every room unless one is named, and each hit says where it is', async () => {
  const a = await posted({ text: 'zebra crossing in main' }, 'grok');
  const b = await posted({ text: 'zebra stripes in calm', room: 'calm' }, 'david');
  const found = await list('?q=zebra');
  assert.deepEqual(found.messages.map((m) => [m.id, m.room]), [[b.id, 'calm'], [a.id, 'main']]);
  assert.deepEqual(ids((await list('?q=zebra&room=calm')).messages), [b.id]);
  assert.deepEqual(ids((await list('?q=zebra&room=main')).messages), [a.id]);
  assert.deepEqual(ids((await list('?q=zebra&room=all')).messages), [b.id, a.id]);
  assert.equal((await call(messages.GET, '/api/messages?q=zebra&room=nowhere', 'david')).status, 404);
});

test('GET /api/rooms counts what the caller has not seen, per room', async () => {
  const { rooms: now } = await rooms();
  const main = must(now.find((r) => r.id === 'main'));
  const calm = must(now.find((r) => r.id === 'calm'));
  const seen = `main:${main.last_id},calm:${calm.last_id}`;
  assert.deepEqual((await rooms(`?seen=${seen}`)).rooms.map((r) => r.unread), [0, 0, 0]);
  await posted({ text: 'news for david', room: 'calm' }, 'grok');
  await posted({ text: 'david himself', room: 'calm' }, 'david');
  const after = await rooms(`?seen=${seen}`, 'david');
  assert.deepEqual(after.rooms.map((r) => [r.id, r.unread]), [['main', 0], ['calm', 1], ['buro-2', 0]]);
  assert.deepEqual((await rooms(`?seen=${seen}`, 'claude')).rooms.map((r) => r.unread), [0, 2, 0], 'counted for the caller');
  assert.ok((await rooms('?seen=')).rooms.every((r) => typeof r.unread === 'number'), 'an empty list counts every room from the start');
  assert.equal((await call(roomsRoute.GET, '/api/rooms?seen=main', 'david')).status, 400);
});

test('polls, decision cards, pins and the export take the room', async () => {
  const pollRes = await call(pollsRoute.POST, '/api/polls', 'david', { question: 'Calm poll?', options: ['Yes', 'No'], room: 'calm' });
  assert.equal(pollRes.status, 201);
  const poll = (await pollRes.json()) as { message: Message; poll: { id: string } };
  assert.equal(poll.message.room, 'calm');
  assert.equal((await call(pollsRoute.POST, '/api/polls', 'david', { question: 'Q?', options: ['A', 'B'], room: 'nowhere' })).status, 404);
  assert.equal((await call(pollsRoute.POST, '/api/polls', 'david', { question: 'Q?', options: ['A', 'B'], room: 7 })).status, 400);
  const closed = (await (await call(closeRoute.POST, `/api/polls/${poll.poll.id}/close`, 'david', {}, { params: Promise.resolve({ id: poll.poll.id }) })).json()) as { message: Message };
  assert.equal(closed.message.room, 'calm');

  const cardRes = await call(decisionsRoute.POST, '/api/decisions', 'claude', { prompt: 'Calm card?', room: 'calm' });
  assert.equal(cardRes.status, 201);
  const card = (await cardRes.json()) as { message: Message };
  assert.equal(card.message.room, 'calm');
  assert.equal((await call(decisionsRoute.POST, '/api/decisions', 'claude', { prompt: 'Nowhere?', room: 'nowhere' })).status, 404);
  assert.equal((await call(decisionsRoute.POST, '/api/decisions', 'claude', { prompt: 'Across?', reply_to: card.message.id, room: 'main' })).status, 409);

  // Pinning answers with the pinned list of the message's own room.
  const pinned = (await (await call(pinRoute.POST, `/api/messages/${card.message.id}/pin`, 'grok', { pinned: true }, { params: Promise.resolve({ id: String(card.message.id) }) })).json()) as { message: Message; pinned: Message[] };
  assert.equal(pinned.message.room, 'calm');
  assert.ok(pinned.pinned.length > 0 && pinned.pinned.every((m) => m.room === 'calm'));
  assert.deepEqual(ids((await list('?room=calm')).pinned), ids(pinned.pinned));

  const main = await call(exportRoute.GET, '/api/export', 'david');
  const mainText = await main.text();
  assert.match(main.headers.get('content-disposition') ?? '', /filename="trialog-\d{4}-\d\d-\d\d\.md"/);
  assert.ok(mainText.startsWith('# Trialog transcript\n') && !mainText.includes('Calm poll?'), 'the export without a room is main, as before');
  const calm = await call(exportRoute.GET, '/api/export?room=calm', 'david');
  const calmText = await calm.text();
  assert.match(calm.headers.get('content-disposition') ?? '', /filename="trialog-calm-\d{4}-\d\d-\d\d\.md"/);
  assert.ok(calmText.startsWith('# Trialog transcript: Calm talk\n') && calmText.includes('Calm poll?') && !calmText.includes('plain, as before'));
  const all = await (await call(exportRoute.GET, '/api/export?room=all', 'david')).text();
  assert.ok(all.startsWith('# Trialog transcript: all rooms\n') && all.includes('Calm poll?') && all.includes('plain, as before'));
  assert.equal((await call(exportRoute.GET, '/api/export?room=nowhere', 'david')).status, 404);
});

test('GET /api/stream takes the room, and refuses one that is not there', async () => {
  assert.equal((await call(streamRoute.GET, '/api/stream?room=nowhere', 'david')).status, 404);
  assert.equal((await call(streamRoute.GET, '/api/stream?room=all', 'david')).status, 400);
  assert.equal((await call(streamRoute.GET, '/api/stream?room=calm&seen=nonsense', 'david')).status, 400);
  const abort = new AbortController();
  const res = await streamRoute.GET(new Request(`${URL_BASE}/api/stream?room=calm&seen=main:0`, { headers: auth('david'), signal: abort.signal }));
  assert.equal(res.status, 200);
  const r = reader(must(res.body));
  const [hello, initial, , , list4] = await r.next(5);
  assert.deepEqual((hello.data as { me: string; room: string }).room, 'calm');
  assert.ok((initial.data as Message[]).every((m) => m.room === 'calm'));
  assert.ok(must((list4.data as Room[]).find((room) => room.id === 'main')).unread! > 0);
  abort.abort();
  await r.finished();
});

test('reading through the API: the position is in the room of the list or of the message', async () => {
  const main = await posted({ text: 'to read in main' }, 'david');
  const calm = await posted({ text: 'to read in calm', room: 'calm' }, 'david');
  type WithReads = { messages: Message[]; reads: ReadPosition[] };
  const get = async (query: string, who: string) => (await (await call(messages.GET, `/api/messages${query}`, who)).json()) as WithReads;

  // Reading calm marks calm, and the list of positions that comes back is calm's.
  const readCalm = await get(`?room=calm&since=${calm.id - 1}&markRead=1&reads=1`, 'grok');
  assert.deepEqual(ids(readCalm.messages), [calm.id]);
  assert.deepEqual(readCalm.reads.filter((p) => p.participant === 'grok').map((p) => [p.room, p.up_to]), [['calm', calm.id]]);
  // A call without a room is about main, as before: grok has read nothing there yet.
  const mainReads = await get('?reads=1', 'david');
  assert.ok(mainReads.reads.every((p) => p.room === 'main'));
  assert.ok(!mainReads.reads.some((p) => p.participant === 'grok'), 'reading calm did not move grok in main');
  // Reading main marks main, to an id below the calm position.
  const readMain = await get(`?since=${main.id - 1}&markRead=1&reads=1`, 'grok');
  assert.deepEqual(readMain.reads.filter((p) => p.participant === 'grok').map((p) => [p.room, p.up_to]), [['main', main.id]]);

  // Every room at once marks each room up to the highest id it has in the list.
  const both = await get(`?room=all&since=${main.id - 1}&markRead=1&reads=1`, 'claude');
  assert.deepEqual(both.reads.filter((p) => p.participant === 'claude').map((p) => [p.room, p.up_to]).sort(), [['calm', calm.id], ['main', main.id]]);

  // PUT /api/read: the message says which room; a room that is named must be that one.
  const put = (body: unknown, who: string) => readRoute.PUT(new Request(`${URL_BASE}/api/read`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth(who) }, body: JSON.stringify(body) }));
  const plain = (await (await put({ upTo: calm.id }, 'david')).json()) as { read: ReadPosition };
  assert.deepEqual([plain.read.participant, plain.read.room, plain.read.up_to], ['david', 'calm', calm.id]);
  assert.equal((await put({ upTo: calm.id, room: 'calm' }, 'david')).status, 200);
  const wrong = await put({ upTo: calm.id, room: 'main' }, 'david');
  assert.equal(wrong.status, 409);
  assert.match(await errorOf(wrong), new RegExp(`Message #${calm.id} is in the room "calm", not in "main"`));
  assert.equal((await put({ upTo: calm.id, room: 'Not An Id' }, 'david')).status, 400);
  assert.equal((await put({ upTo: 999_999 }, 'david')).status, 404);
  assert.ok(!(await get('?reads=1', 'grok')).reads.some((p) => p.participant === 'david'), 'david has still read nothing in main');
});

// The page's fallback asks for these lists with every poll for new messages, so a list that
// forgets the room would hand one room's polls, reactions and cards to a reader of another.
test('GET /api/messages?polls=1: only the polls of the room that was asked for', async () => {
  const inMain = (await (await call(pollsRoute.POST, '/api/polls', 'david', { question: 'Leak check, main poll?', options: ['A', 'B'] })).json()) as { poll: { id: string } };
  const inCalm = (await (await call(pollsRoute.POST, '/api/polls', 'david', { question: 'Leak check, calm poll?', options: ['A', 'B'], room: 'calm' })).json()) as { poll: { id: string } };
  const polls = async (query: string) => ((await (await call(messages.GET, `/api/messages?polls=1&reactions=1&decisions=1${query}`, 'grok')).json()) as { polls: { id: string }[] }).polls.map((p) => p.id);
  const calm = await polls('&room=calm');
  assert.ok(calm.includes(inCalm.poll.id) && !calm.includes(inMain.poll.id), 'calm must not list a poll of main');
  const main = await polls('');
  assert.ok(main.includes(inMain.poll.id) && !main.includes(inCalm.poll.id), 'main, also when no room is named, must not list a poll of calm');
  const all = await polls('&room=all');
  assert.ok(all.includes(inMain.poll.id) && all.includes(inCalm.poll.id));
});

test('GET /api/messages?reactions=1: only the reactions of the room that was asked for', async () => {
  const inMain = await posted({ text: 'leak check, a message in main' }, 'david');
  const inCalm = await posted({ text: 'leak check, a message in calm', room: 'calm' }, 'david');
  const store = await (await import('../lib/store')).getStore();
  await store.addReaction(inMain.id, 'claude', '👍');
  await store.addReaction(inCalm.id, 'claude', '🎉');
  const reacted = async (query: string) => ((await (await call(messages.GET, `/api/messages?polls=1&reactions=1&decisions=1${query}`, 'grok')).json()) as { reactions: { message_id: number }[] }).reactions.map((r) => r.message_id);
  const calm = await reacted('&room=calm');
  assert.ok(calm.includes(inCalm.id) && !calm.includes(inMain.id), 'calm must not list a reaction on a message of main');
  const main = await reacted('');
  assert.ok(main.includes(inMain.id) && !main.includes(inCalm.id), 'main must not list a reaction on a message of calm');
  const all = await reacted('&room=all');
  assert.ok(all.includes(inMain.id) && all.includes(inCalm.id));
});

test('GET /api/messages?decisions=1: only the decision cards of the room that was asked for', async () => {
  const inMain = (await (await call(decisionsRoute.POST, '/api/decisions', 'claude', { prompt: 'Leak check, main card?' })).json()) as { decision: { id: string } };
  const inCalm = (await (await call(decisionsRoute.POST, '/api/decisions', 'claude', { prompt: 'Leak check, calm card?', room: 'calm' })).json()) as { decision: { id: string } };
  const cards = async (query: string) => ((await (await call(messages.GET, `/api/messages?polls=1&reactions=1&decisions=1${query}`, 'grok')).json()) as { decisions: { id: string }[] }).decisions.map((c) => c.id);
  const calm = await cards('&room=calm');
  assert.ok(calm.includes(inCalm.decision.id) && !calm.includes(inMain.decision.id), 'calm must not list a card of main');
  const main = await cards('');
  assert.ok(main.includes(inMain.decision.id) && !main.includes(inCalm.decision.id), 'main must not list a card of calm');
  const all = await cards('&room=all');
  assert.ok(all.includes(inMain.decision.id) && all.includes(inCalm.decision.id));
});

test('GET /api/wake takes the room like the messages do', async () => {
  const inMain = await posted({ text: 'wake check, the human in main' }, 'david');
  const inCalm = await posted({ text: 'wake check, the human in calm', room: 'calm' }, 'david');
  const wake = async (query: string, who = 'grok') => {
    const res = await call(wakeRoute.GET, `/api/wake${query}`, who);
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { messages: Message[] }).messages;
  };
  const since = `since=${inMain.id - 1}`;
  assert.deepEqual((await wake(`?${since}`)).map((m) => [m.id, m.room]), [[inMain.id, 'main']], 'without a room: main, as for every other list');
  assert.deepEqual((await wake(`?${since}&room=calm`)).map((m) => [m.id, m.room]), [[inCalm.id, 'calm']]);
  assert.deepEqual((await wake(`?${since}&room=all`)).map((m) => [m.id, m.room]), [[inMain.id, 'main'], [inCalm.id, 'calm']]);
  assert.deepEqual(await wake(`?${since}&room=all`, 'david'), [], 'a human is not woken, in any room');
  assert.equal((await call(wakeRoute.GET, '/api/wake?room=nowhere', 'grok')).status, 404);
  assert.equal((await call(wakeRoute.GET, '/api/wake?room=Not%20An%20Id', 'grok')).status, 400);
});

test('a hub has at most twelve rooms', async () => {
  const have = (await rooms()).rooms.length;
  for (let i = have; i < MAX_ROOMS; i++) assert.equal((await call(roomsRoute.POST, '/api/rooms', 'grok', { name: `Room ${i}`, id: `room-${i}` })).status, 201);
  const full = await call(roomsRoute.POST, '/api/rooms', 'grok', { name: 'One too many' });
  assert.equal(full.status, 409);
  assert.match(await errorOf(full), /at most 12 rooms/);
  assert.equal((await rooms()).rooms.length, MAX_ROOMS);
});
