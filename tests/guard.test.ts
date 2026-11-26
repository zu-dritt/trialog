// The loop and cost guard: the rules (lib/guard.ts), the store's recent activity on PGlite and in
// memory, the hub's notice (lib/guard-hub.ts) and wake-ups held back while it is tripped.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  DAY_MS, GUARD_DEFAULTS, HOUR_MS, activitySince, guardLimits, guardReport, guardState, headsUpAt, headsUpGiven, headsUpText,
  hourBuckets, noticeFor, noticeRecipient, pauseText, pausesIn24h, type ActivityRow, type GuardLimits,
} from '../lib/guard';
import { currentGuard, postGuardNotice } from '../lib/guard-hub';
import { parseParticipants } from '../lib/participants';
import { createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { PAUSED_ERROR, createWakeup } from '../lib/webhook';

const ROSTER = parseParticipants('ana:human,scout:agent,quill:agent');
const LIMITS: GuardLimits = { perHour: 6, inARow: 4, perDay: 10 };
const NOW = Date.parse('2026-11-26T12:30:00Z');

/** Rows from a list of senders, one minute apart, the last one a minute before `end`. */
function rows(senders: string[], end = NOW): ActivityRow[] {
  return senders.map((sender, i) => ({
    id: i + 1,
    sender,
    created_at: new Date(end - (senders.length - i) * 60_000).toISOString(),
    head: sender === 'hub' ? 'Welcome' : null,
  }));
}
const at = (id: number, sender: string, t: number, head: string | null = null): ActivityRow => ({ id, sender, created_at: new Date(t).toISOString(), head });

test('the limits come from GUARD_PER_HOUR, GUARD_IN_A_ROW and GUARD_PER_DAY; anything unusable is the default', () => {
  assert.deepEqual(guardLimits({}), GUARD_DEFAULTS);
  assert.deepEqual(GUARD_DEFAULTS, { perHour: 60, inARow: 12, perDay: 300 });
  assert.deepEqual(guardLimits({ GUARD_PER_HOUR: '30', GUARD_IN_A_ROW: ' 5 ', GUARD_PER_DAY: '1000' }), { perHour: 30, inARow: 5, perDay: 1000 });
  for (const bad of ['0', '-3', '2.5', 'ten', '', '1e3', '99999999']) {
    assert.deepEqual(guardLimits({ GUARD_PER_HOUR: bad, GUARD_IN_A_ROW: bad, GUARD_PER_DAY: bad }), GUARD_DEFAULTS, bad);
  }
  assert.equal(headsUpAt(GUARD_DEFAULTS), 240);
  assert.equal(headsUpAt(LIMITS), 8);
});

test('only agents count; the hub, humans and former participants do not', () => {
  const state = guardState(rows(['hub', 'scout', 'ana', 'quill', 'gone', 'scout']), ROSTER, LIMITS, NOW);
  assert.deepEqual(state, { hour: 3, inARow: 2, day: 3, tripped: null });
});

test('in a row: the count starts again at every human message, in every room', () => {
  assert.equal(guardState(rows(['scout', 'quill', 'scout']), ROSTER, LIMITS, NOW).tripped, null);
  assert.equal(guardState(rows(['scout', 'quill', 'scout', 'quill']), ROSTER, LIMITS, NOW).tripped, 'in-a-row');
  assert.equal(guardState(rows(['scout', 'quill', 'scout', 'quill', 'ana']), ROSTER, LIMITS, NOW).tripped, null, 'a human message lifts it');
  assert.equal(guardState(rows(['scout', 'quill', 'scout', 'quill', 'ana', 'scout', 'quill', 'scout', 'quill']), ROSTER, LIMITS, NOW).tripped, 'in-a-row', 'and it can trip again');
  assert.equal(guardState(rows(['scout', 'quill', 'hub', 'scout', 'quill']), ROSTER, LIMITS, NOW).inARow, 4, 'the hub is no human');
});

test('per hour: a rolling 60 minutes, lifted by a human message after the Nth agent message', () => {
  const limits = { ...LIMITS, inARow: 100 };
  const six = ['scout', 'quill', 'scout', 'quill', 'scout', 'quill'];
  assert.equal(guardState(rows(six.slice(0, 5)), ROSTER, limits, NOW).tripped, null);
  assert.equal(guardState(rows(six), ROSTER, limits, NOW).tripped, 'hour');
  assert.equal(guardState(rows([...six, 'ana']), ROSTER, limits, NOW).tripped, null, 'a human after the 6th');
  assert.equal(guardState(rows([...six, 'ana', 'scout', 'quill']), ROSTER, limits, NOW).tripped, null, 'for the rest of the window');
  assert.equal(guardState(rows(['scout', 'ana', 'quill', 'scout', 'quill', 'scout', 'quill']), ROSTER, limits, NOW).tripped, 'hour', 'a human before the 6th does not');
  // The same six, but more than an hour ago: they have left the window.
  const old = six.map((s, i) => at(i + 1, s, NOW - HOUR_MS - (10 - i) * 60_000));
  assert.deepEqual(guardState(old, ROSTER, limits, NOW), { hour: 0, inARow: 6, day: 6, tripped: null });
});

test('per day: a rolling 24 hours, the same way', () => {
  const limits = { perHour: 100, inARow: 100, perDay: 10 };
  // Ten agent messages spread over the day, one every two hours.
  const spread = Array.from({ length: 10 }, (_, i) => at(i + 1, i % 2 ? 'quill' : 'scout', NOW - (20 - 2 * i) * HOUR_MS));
  assert.equal(guardState(spread, ROSTER, limits, NOW).tripped, 'day');
  assert.equal(guardState([...spread, at(11, 'ana', NOW - 60_000)], ROSTER, limits, NOW).tripped, null);
  assert.equal(guardState(spread, ROSTER, limits, NOW + 5 * HOUR_MS).tripped, null, 'once the oldest have left the window');
});

test('the in-a-row limit is named first when several hold', () => {
  const ten = Array.from({ length: 10 }, (_, i) => (i % 2 ? 'quill' : 'scout'));
  assert.equal(guardState(rows(ten), ROSTER, LIMITS, NOW).tripped, 'in-a-row');
});

test('the notices: one when the guard trips, one heads-up at 80% of the day, and the texts', () => {
  const free = { hour: 3, inARow: 3, day: 7, tripped: null };
  assert.deepEqual(noticeFor(free, { hour: 4, inARow: 4, day: 8, tripped: 'in-a-row' }, LIMITS, false),
    { kind: 'pause', limit: 'in-a-row', text: pauseText('in-a-row', LIMITS) });
  assert.equal(noticeFor({ ...free, tripped: 'in-a-row' }, { hour: 5, inARow: 5, day: 9, tripped: 'in-a-row' }, LIMITS, false), null, 'already tripped: nothing more');
  assert.deepEqual(noticeFor(free, { hour: 4, inARow: 1, day: 8, tripped: null }, LIMITS, false), { kind: 'heads-up', text: headsUpText(8, LIMITS) });
  assert.equal(noticeFor(free, { hour: 4, inARow: 1, day: 8, tripped: null }, LIMITS, true), null, 'once per 24 hours');
  assert.equal(noticeFor({ ...free, day: 8 }, { hour: 4, inARow: 1, day: 9, tripped: null }, LIMITS, false), null, 'only when crossing');

  assert.equal(pauseText('in-a-row', GUARD_DEFAULTS), 'Guard: wake-ups paused, 12 agent messages in a row without a human. Write anything to continue.');
  assert.equal(pauseText('hour', GUARD_DEFAULTS), 'Guard: wake-ups paused, 60 agent messages in the last hour. Write anything to continue.');
  assert.equal(pauseText('day', GUARD_DEFAULTS), 'Guard: wake-ups paused, 300 agent messages in the last 24 hours. Write anything to continue.');
  assert.match(headsUpText(240, GUARD_DEFAULTS), /^Guard: heads-up: 240 of 300 agent messages/);

  assert.equal(noticeRecipient(ROSTER), 'ana');
  assert.equal(noticeRecipient(parseParticipants('ana:human,ben:human,scout:agent')), null, 'two humans: to everyone');
});

test('pauses and the heads-up are found among the hub messages of the last 24 hours', () => {
  const list = [
    at(1, 'hub', NOW - 25 * HOUR_MS, pauseText('hour', LIMITS)),
    at(2, 'hub', NOW - 3 * HOUR_MS, pauseText('in-a-row', LIMITS)),
    at(3, 'scout', NOW - 2 * HOUR_MS, null),
    at(4, 'hub', NOW - HOUR_MS, pauseText('day', LIMITS).slice(0, 40)),
    at(5, 'hub', NOW - HOUR_MS, 'Welcome to Trialog'),
  ];
  assert.equal(pausesIn24h(list, NOW), 2);
  assert.equal(headsUpGiven(list, NOW), false);
  assert.equal(headsUpGiven([...list, at(6, 'hub', NOW - 60_000, headsUpText(8, LIMITS).slice(0, 40))], NOW), true);
  assert.equal(headsUpGiven([at(6, 'hub', NOW - DAY_MS - 1, headsUpText(8, LIMITS))], NOW), false, 'an older one no longer counts');
});

test('the chart: 24 clock hours, the current one last, per agent', () => {
  assert.equal(activitySince(NOW), Date.parse('2026-11-25T13:00:00Z'));
  const list = [
    at(1, 'scout', Date.parse('2026-11-25T13:10:00Z')),
    at(2, 'scout', Date.parse('2026-11-25T12:59:00Z')), // before the first hour: left out
    at(3, 'quill', Date.parse('2026-11-26T12:05:00Z')),
    at(4, 'ana', Date.parse('2026-11-26T12:06:00Z')),
    at(5, 'scout', Date.parse('2026-11-26T12:20:00Z')),
  ];
  const hours = hourBuckets(list, ROSTER, NOW);
  assert.equal(hours.length, 24);
  assert.equal(hours[0].start, '2026-11-25T13:00:00.000Z');
  assert.equal(hours[23].start, '2026-11-26T12:00:00.000Z');
  assert.deepEqual(hours[0].bySender, { scout: 1, quill: 0 });
  assert.deepEqual(hours[23].bySender, { scout: 1, quill: 1 });
  assert.deepEqual(hours[5].bySender, { scout: 0, quill: 0 });

  const report = guardReport(list, ROSTER, LIMITS, NOW);
  assert.deepEqual(Object.keys(report), ['limits', 'now', 'tripped', 'hours', 'pausesToday']);
  assert.deepEqual(report.now, { hour: 2, inARow: 1, day: 4 }, 'the day is the last 24 hours, not the 24 clock hours of the chart');
  assert.equal(report.tripped, null);
  assert.equal(report.pausesToday, 0);
});

// --- the store, the hub's notice and the wake-ups ----------------------------------------------

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}
const stores: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];

for (const [name, make] of stores) {
  test(`${name}: recent activity lists every room in id order, with the start of the hub's texts only`, async () => {
    const store = await make();
    const since = Date.now() - 1000;
    await store.createRoom({ id: 'calm', name: 'Calm', created_by: 'ana' });
    await store.add({ sender: 'scout', recipient: null, text: 'one' });
    await store.add({ sender: 'ana', recipient: null, text: 'two', room: 'calm' });
    const list = await store.recentActivity(since);
    assert.deepEqual(list.map((r) => [r.sender, r.head === null ? null : 'text']), [['hub', 'text'], ['scout', null], ['ana', null]]);
    assert.ok(list[0].head?.startsWith('**Welcome to Trialog.**'));
    assert.equal(list[0].head?.length, 40, 'only the start of the text');
    assert.ok(list.every((r, i) => i === 0 || r.id > list[i - 1].id));
    assert.deepEqual(await store.recentActivity(Date.now() + 60_000), [], 'nothing from the future');
  });

  test(`${name}: the hub posts one notice when an agent message trips the guard, and wake-ups are held back`, async () => {
    const store = await make();
    const ctx = { roster: ROSTER, limits: LIMITS };
    await store.add({ sender: 'ana', recipient: null, text: 'go' });
    const posted = [];
    for (let i = 0; i < 4; i++) {
      const m = (await store.add({ sender: i % 2 ? 'quill' : 'scout', recipient: null, text: `ping ${i}` }))!;
      posted.push(await postGuardNotice(store, m, { ...ctx, now: Date.now() }));
    }
    assert.deepEqual(posted.slice(0, 3), [null, null, null]);
    const notice = posted[3];
    assert.ok(notice);
    assert.equal(notice.sender, 'hub');
    assert.equal(notice.recipient, 'ana');
    assert.equal(notice.text, pauseText('in-a-row', LIMITS));
    assert.equal((await currentGuard(store, ctx)).tripped, 'in-a-row');
    // A fifth agent message: still tripped, no second notice.
    const fifth = (await store.add({ sender: 'scout', recipient: null, text: 'ping 4' }))!;
    assert.equal(await postGuardNotice(store, fifth, ctx), null);

    // Wake-ups that come due now are closed as failed, with the reason, and never sent.
    const sent: string[] = [];
    const wakeup = createWakeup({
      store, roster: ROSTER, sleep: async () => {}, debounceMs: 0, enforcePublicTarget: false,
      fallbackTargets: { quill: { url: 'https://quill.example/wake', secret: 'quill-secret-0123456789' } },
      fetch: (async (url: string) => { sent.push(url); return new Response(null, { status: 204 }); }) as unknown as typeof fetch,
      guard: async () => (await currentGuard(store, ctx)).tripped,
    });
    const paused = await wakeup.onMessage(fifth);
    assert.equal(paused?.status, 'paused');
    assert.deepEqual(sent, []);
    assert.deepEqual((await store.listWakes([fifth.id])).map((d) => [d.participant, d.status, d.error]), [['quill', 'failed', PAUSED_ERROR]]);

    // A human message lifts the pause, and wakes the agents as always.
    const human = (await store.add({ sender: 'ana', recipient: null, text: 'carry on' }))!;
    assert.equal(await postGuardNotice(store, human, ctx), null);
    assert.equal((await currentGuard(store, ctx)).tripped, null);
    const woken = await wakeup.onMessage(human);
    assert.equal(woken?.status, 'delivered');
    assert.deepEqual(sent, ['https://quill.example/wake']);
    assert.deepEqual((await store.listWakes([fifth.id])).map((d) => d.status), ['failed'], 'the held-back one is not sent later');
  });

  test(`${name}: a heads-up once at 80% of the day, in the room of the message`, async () => {
    const store = await make();
    await store.createRoom({ id: 'fast', name: 'Fast', created_by: 'ana' });
    const ctx = { roster: ROSTER, limits: { perHour: 100, inARow: 100, perDay: 5 } }; // heads-up at 4
    const notices = [];
    for (let i = 0; i < 4; i++) {
      const m = (await store.add({ sender: 'scout', recipient: null, text: `n${i}`, room: 'fast' }))!;
      notices.push(await postGuardNotice(store, m, ctx));
    }
    assert.deepEqual(notices.slice(0, 3), [null, null, null]);
    assert.equal(notices[3]?.room, 'fast');
    assert.match(notices[3]?.text ?? '', /^Guard: heads-up: 4 of 5/);
    // A fifth message is the limit itself: the pause notice, not a second heads-up.
    const fifth = (await store.add({ sender: 'scout', recipient: null, text: 'n4', room: 'fast' }))!;
    assert.equal((await postGuardNotice(store, fifth, ctx))?.text, pauseText('day', ctx.limits));
    const report = guardReport(await store.recentActivity(activitySince(Date.now())), ROSTER, ctx.limits, Date.now());
    assert.equal(report.now.day, 5);
    assert.equal(report.tripped, 'day');
    assert.equal(report.pausesToday, 1);
  });
}

test('sql: the hub can post more than its welcome, and an old database loses the index that forbade it', async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT, text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), pinned_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX messages_one_welcome ON messages (sender) WHERE sender = 'hub';
    INSERT INTO messages (sender, text) VALUES ('hub', 'welcome');`);
  const store = createSqlStore(pgliteDb(pg));
  assert.ok(await store.add({ sender: 'hub', recipient: null, text: pauseText('hour', LIMITS) }));
  const indexes = (await pg.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'messages'`)).rows.map((r) => r.indexname);
  assert.ok(!indexes.includes('messages_one_welcome'));
  assert.ok(indexes.includes('messages_created_at'));
  // Two cold starts at once on an empty database still give one welcome.
  const empty = new PGlite();
  await Promise.all([createSqlStore(pgliteDb(empty)).ensure(), createSqlStore(pgliteDb(empty)).ensure()]);
  assert.equal((await empty.query(`SELECT 1 FROM messages WHERE sender = 'hub'`)).rows.length, 1);
  await pg.close();
  await empty.close();
});
