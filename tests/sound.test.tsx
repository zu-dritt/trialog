// Sound mode: which note each participant gets, which change makes which sound, what is skipped
// (too soon, your own, a hidden tab), the switch and its memory, and what the sound engine builds,
// on a fake audio context. Hearing it needs a person; see the pull request.
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../lib/core';
import type { DecisionCard, Participant } from '../lib/shared';
import {
  GATHER_MS, MASTER_GAIN, MIN_GAP_MS, SOUND_KEY, SOUND_OFF_HINT, SOUND_ON_HINT, SoundToggle, addressedCues, audible, chordNotes,
  createSoundEngine, createSoundPlayer, knownAfter, readSoundOn, roomsWithNews, snapshotOf, soundCues, writeSoundOn,
  type AudioContextLike, type Cue,
} from '../app/sound';

afterEach(() => { vi.useRealTimers(); });

const D4 = 293.6648;
const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 0.01, `${a} ≠ ${b}`);
const semitones = (f: number) => Math.round(12 * Math.log2(f / D4)) + 0; // + 0: no -0

const ROSTER: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0 },
  { name: 'claude', kind: 'agent', color: 1 },
  { name: 'david', kind: 'human', color: 2 },
];
const NAMES = ROSTER.map((p) => p.name);

let nextId = 1;
const msg = (sender: string, extra: Partial<Message> = {}): Message => ({
  id: nextId++, sender, recipient: null, text: 'hello', created_at: '2026-11-26T10:00:00Z', pinned_at: null, room: 'main',
  attachments: [], reply_to: null, reactions: [], ...extra,
});
const card = (id: string, agreed: string[], agreedAt: string | null = null): DecisionCard => ({
  id, message_id: 1, creator: 'claude', prompt: 'Keep building?', created_at: '2026-11-26T10:00:00Z', agreed_at: agreedAt,
  positions: agreed.map((participant) => ({ participant, stance: 'agree', note: null, updated_at: '2026-11-26T10:00:00Z' })) as DecisionCard['positions'],
});

// --- the notes ---

test('the human gets the root, the agents the third and the fifth, in roster order', () => {
  const notes = chordNotes(ROSTER);
  close(notes.get('david'), D4);
  assert.equal(semitones(notes.get('grok')!), 4, 'grok, the first agent on the roster: the third');
  assert.equal(semitones(notes.get('claude')!), 7, 'claude, the second: the fifth');
  // Another order of the roster is another order of the notes.
  const swapped = chordNotes([ROSTER[1], ROSTER[0], ROSTER[2]]);
  assert.equal(semitones(swapped.get('claude')!), 4);
  assert.equal(semitones(swapped.get('grok')!), 7);
  close(swapped.get('david'), D4);
});

test('the same roster gives the same notes, every time', () => {
  const first = [...chordNotes(ROSTER)];
  for (let i = 0; i < 5; i++) assert.deepEqual([...chordNotes(ROSTER.map((p) => ({ ...p })))], first);
  // Where the human stands in the roster does not matter for the human; the agents keep their order.
  const humanFirst = chordNotes([ROSTER[2], ROSTER[0], ROSTER[1]]);
  assert.deepEqual([...humanFirst].sort(), first.sort());
});

test('twelve participants get twelve different notes of one chord; humans get a D', () => {
  for (const humans of [0, 1, 2, 3, 5, 12]) {
    const roster: Participant[] = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, kind: i < humans ? 'human' : 'agent', color: i }));
    const notes = chordNotes(roster);
    assert.equal(notes.size, 12, `${humans} humans: everyone has a note`);
    assert.equal(new Set([...notes.values()].map((f) => f.toFixed(3))).size, 12, `${humans} humans: all different`);
    // Every note is a tone of D major with its seventh and ninth: D, E, F#, A, B, C#.
    for (const f of notes.values()) assert.ok([0, 2, 4, 7, 9, 11].includes(((semitones(f) % 12) + 12) % 12), String(f));
    // The first three humans get a D, in three octaves.
    roster.filter((p) => p.kind === 'human').slice(0, 3).forEach((p) => assert.equal(((semitones(notes.get(p.name)!) % 12) + 12) % 12, 0, p.name));
  }
});

// --- which change makes which sound ---

test('a new message from someone else plays its sender’s note; your own never does', () => {
  const history = [msg('grok'), msg('david')];
  const before = snapshotOf(history, 'david', NAMES);
  const fromClaude = msg('claude');
  const mine = msg('david');
  const cues = soundCues(before, [...history, fromClaude, mine], 'david', ROSTER);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].kind, 'note');
  close((cues[0] as Extract<Cue, { kind: 'note' }>).freq, chordNotes(ROSTER).get('claude')!);
  // Your own message alone: nothing (its confirmation is played when it is sent).
  assert.deepEqual(soundCues(before, [...history, mine], 'david', ROSTER), []);
});

test('history and older messages loaded later are quiet; so is a name that is not on the roster', () => {
  const recent = [msg('grok'), msg('claude')];
  const before = snapshotOf(recent, 'david', NAMES);
  const older = { ...msg('grok'), id: 0 }; // loaded when going to an old message
  assert.deepEqual(soundCues(before, [older, ...recent], 'david', ROSTER), []);
  assert.deepEqual(soundCues(before, [...recent, msg('hub')], 'david', ROSTER), [], 'the hub’s welcome has no note');
  assert.deepEqual(soundCues(before, recent, 'david', ROSTER), [], 'nothing changed');
});

test('a message addressed to you is marked as such', () => {
  const before = snapshotOf([], 'david', NAMES);
  const [toMe] = soundCues(before, [msg('grok', { recipient: 'david' })], 'david', ROSTER);
  const [toAll] = soundCues(before, [msg('grok')], 'david', ROSTER);
  const [toClaude] = soundCues(before, [msg('grok', { recipient: 'claude' })], 'david', ROSTER);
  assert.deepEqual([toMe, toAll, toClaude].map((c) => c.kind === 'note' && c.addressed), [true, false, false]);
});

test('a reaction by someone else on your message ticks; on another message, or your own, it does not', () => {
  const mine = msg('david');
  const theirs = msg('grok');
  const before = snapshotOf([mine, theirs], 'david', NAMES);
  const reacted = (m: Message, by: string[]) => ({ ...m, reactions: [{ emoji: '👍', by }] });
  assert.deepEqual(soundCues(before, [reacted(mine, ['grok']), theirs], 'david', ROSTER), [{ kind: 'reaction' }]);
  assert.deepEqual(soundCues(before, [reacted(mine, ['david']), theirs], 'david', ROSTER), [], 'your own reaction');
  assert.deepEqual(soundCues(before, [mine, reacted(theirs, ['claude'])], 'david', ROSTER), [], 'someone else’s message');
  // A reaction taken back is quiet too.
  const withOne = snapshotOf([reacted(mine, ['grok'])], 'david', NAMES);
  assert.deepEqual(soundCues(withOne, [mine], 'david', ROSTER), []);
});

test('a decision everyone has agreed plays the whole chord, once', () => {
  const open = msg('claude', { decision: card('d1', ['claude', 'grok']) });
  let snap = snapshotOf([open], 'david', NAMES);
  const agreed = { ...open, decision: card('d1', NAMES, '2026-11-26T10:05:00Z') };
  const cues = soundCues(snap, [agreed], 'david', ROSTER);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].kind, 'agreed');
  assert.deepEqual((cues[0] as Extract<Cue, { kind: 'agreed' }>).freqs.map(semitones).sort((a, b) => a - b), [0, 4, 7]);
  // Once: the same card again, and also after its consensus broke and came back, is quiet.
  snap = snapshotOf([agreed], 'david', NAMES, snap);
  assert.deepEqual(soundCues(snap, [agreed], 'david', ROSTER), []);
  snap = snapshotOf([open], 'david', NAMES, snap);
  assert.deepEqual(soundCues(snap, [agreed], 'david', ROSTER), []);
  // A card that was agreed already when the page opened is history.
  assert.deepEqual(soundCues(snapshotOf([agreed], 'david', NAMES), [agreed], 'david', ROSTER), []);
});

// --- what is heard, and when ---

function fakeContext() {
  const oscillators: { freq: number; start: number; stop: number }[] = [];
  let peak = 0;
  const param = (onSet?: (v: number) => void) => ({
    value: 0,
    setValueAtTime(v: number) { onSet?.(v); return this; },
    linearRampToValueAtTime(v: number) { onSet?.(v); return this; },
    setTargetAtTime() { return this; },
  });
  const node = () => ({ connect() {} });
  const ctx = {
    get currentTime() { return Date.now() / 1000; }, sampleRate: 8000, state: 'suspended' as AudioContextState, destination: {},
    resume: vi.fn(async () => { ctx.state = 'running'; }),
    createGain: () => ({ ...node(), gain: param((v) => { peak = Math.max(peak, v); }) }),
    createOscillator: () => {
      const o = { ...node(), type: 'sine', frequency: { value: 0 }, start(t: number) { o.at = t; }, stop(t: number) { oscillators.push({ freq: o.frequency.value, start: o.at, stop: t }); }, at: 0 };
      return o;
    },
    createConvolver: () => ({ ...node(), buffer: null }),
    createBuffer: (channels: number, length: number) => { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { getChannelData: (c: number) => data[c] }; },
    createDynamicsCompressor: () => node(),
  };
  return { ctx: ctx as unknown as AudioContextLike & { state: AudioContextState }, oscillators, peak: () => peak };
}

function player({ hidden = false } = {}) {
  vi.useFakeTimers();
  const fake = fakeContext();
  const makeContext = vi.fn(() => fake.ctx);
  const played: Cue[] = [];
  const p = createSoundPlayer({ now: () => Date.now(), later: (ms, run) => { setTimeout(run, ms); }, hidden: () => hidden, makeContext });
  // Count what reaches the engine by the oscillators it starts.
  const count = () => new Set(fake.oscillators.map((o) => o.start)).size;
  return { p, fake, makeContext, played, count };
}
const note = (addressed = false): Cue => ({ kind: 'note', freq: D4, addressed });

test('nothing is made, not even an audio context, until the mode is switched on', () => {
  const { p, makeContext, fake } = player();
  p.wake(); // a click on the page while the mode is off
  p.offer(note());
  vi.advanceTimersByTime(5000);
  assert.equal(makeContext.mock.calls.length, 0);
  assert.equal(fake.oscillators.length, 0);
  // Switched on but no click yet (on from an earlier visit): still quiet, still no context.
  p.setOn(true);
  p.offer(note());
  vi.advanceTimersByTime(5000);
  assert.equal(makeContext.mock.calls.length, 0);
  assert.equal(fake.oscillators.length, 0);
  // The click: the context is made and resumed, and the next sound plays.
  p.wake();
  assert.equal(makeContext.mock.calls.length, 1);
  assert.equal(fake.ctx.state, 'running', 'resumed');
  p.offer(note());
  vi.advanceTimersByTime(GATHER_MS);
  assert.ok(fake.oscillators.length > 0);
});

test('at most one sound per second; the rest is skipped, not saved for later', () => {
  const { p, count } = player();
  p.setOn(true);
  p.wake();
  p.offer(note());
  vi.advanceTimersByTime(GATHER_MS);
  assert.equal(count(), 1);
  vi.advanceTimersByTime(MIN_GAP_MS - GATHER_MS - 100);
  p.offer(note()); // too soon
  vi.advanceTimersByTime(GATHER_MS);
  assert.equal(count(), 1);
  vi.advanceTimersByTime(5000);
  assert.equal(count(), 1, 'nothing comes late');
  p.offer(note());
  vi.advanceTimersByTime(GATHER_MS);
  assert.equal(count(), 2, 'a second later it plays again');
});

test('what arrives together is one sound: the agreed chord wins over the message that completed it', () => {
  const { p, fake } = player();
  p.setOn(true);
  p.wake();
  p.offer(note());
  p.offer({ kind: 'agreed', freqs: [D4, D4 * 2 ** (4 / 12), D4 * 2 ** (7 / 12)] });
  p.offer({ kind: 'reaction' });
  vi.advanceTimersByTime(GATHER_MS);
  const started = [...new Set(fake.oscillators.map((o) => o.start))];
  assert.equal(started.length, 3, 'three strummed bells, nothing else');
  assert.ok(Math.max(...started) - Math.min(...started) < 0.2);
});

test('a hidden tab hears only messages addressed to you and agreed decisions', () => {
  const table: [Cue, boolean][] = [
    [note(false), false], [note(true), true], [{ kind: 'agreed', freqs: [D4] }, true],
    [{ kind: 'sent', freq: D4 }, false], [{ kind: 'reaction' }, false], [{ kind: 'version' }, true], [{ kind: 'waiting' }, true],
  ];
  for (const [cue, heard] of table) {
    assert.equal(audible(cue, true), heard, `${cue.kind} in a hidden tab`);
    assert.equal(audible(cue, false), true, `${cue.kind} in a visible tab`);
  }
  const { p, count } = player({ hidden: true });
  p.setOn(true);
  p.wake();
  p.offer(note(false));
  vi.advanceTimersByTime(GATHER_MS);
  assert.equal(count(), 0);
  p.offer(note(true));
  vi.advanceTimersByTime(GATHER_MS);
  assert.equal(count(), 1);
});

test('switching off stops what is waiting', () => {
  const { p, count } = player();
  p.setOn(true);
  p.wake();
  p.offer(note());
  p.setOn(false);
  vi.advanceTimersByTime(GATHER_MS);
  assert.equal(count(), 0);
});

test('a note is a bell on its frequency with a touch of the second harmonic; everything stays quiet and fades out', () => {
  const fake = fakeContext();
  const engine = createSoundEngine(fake.ctx);
  engine.play(note());
  const freqs = fake.oscillators.map((o) => o.freq);
  assert.ok(freqs.some((f) => Math.abs(f - D4) < 1), 'the note itself');
  assert.ok(freqs.some((f) => Math.abs(f - 2 * D4) < 2), 'its second harmonic');
  assert.ok(fake.oscillators.every((o) => o.stop > o.start && o.stop - o.start < 4), 'every sine ends, within a few seconds');
  assert.ok(MASTER_GAIN <= 0.25);
  for (const cue of [{ kind: 'sent', freq: D4 }, { kind: 'reaction' }, { kind: 'version' }, { kind: 'waiting' }, { kind: 'agreed', freqs: [1, 2, 3, 4, 5, 6].map((i) => D4 * i) }] as Cue[]) engine.play(cue);
  assert.ok(fake.peak() <= 0.5, `no single voice louder than half of a quiet master: ${fake.peak()}`);
});

// --- the switch ---

test('the mode is off by default and remembered in this browser', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(readSoundOn(storage), false, 'a browser that never chose');
  writeSoundOn(storage, true);
  assert.equal(store.get(SOUND_KEY), 'on');
  assert.equal(readSoundOn(storage), true);
  writeSoundOn(storage, false);
  assert.equal(readSoundOn(storage), false);
  // A browser that refuses storage: off, and nothing throws.
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readSoundOn(refusing), false);
  writeSoundOn(refusing, true);
  assert.equal(readSoundOn(undefined), false);
});

test('the switch is one labelled button that says whether it is on', () => {
  const off = renderToStaticMarkup(<SoundToggle on={false} onToggle={() => {}} />);
  const on = renderToStaticMarkup(<SoundToggle on onToggle={() => {}} />);
  for (const out of [off, on]) {
    assert.match(out, /^<button type="button"[^>]*>.*<\/button>$/);
    assert.equal(out.match(/<button/g)?.length, 1);
    assert.ok(out.includes('aria-label="Sound mode"'), out);
    assert.ok(!/tabindex="-1"|animate|transition/.test(out), 'reachable by keyboard, and nothing in it moves');
  }
  assert.ok(off.includes('aria-pressed="false"') && off.includes(`title="${SOUND_OFF_HINT}"`), off);
  assert.ok(on.includes('aria-pressed="true"') && on.includes(`title="${SOUND_ON_HINT}"`), on);
});

// --- rooms that are not open ---

test('a room that is not open and has grown is read from where it was; open rooms are not', () => {
  const known = new Map([['main', 10], ['workshop', 4], ['side', 7]]);
  const rooms = [{ id: 'main', last_id: 12 }, { id: 'workshop', last_id: 9 }, { id: 'side', last_id: 7 }];
  assert.deepEqual(roomsWithNews(known, rooms, ['main']), [{ room: 'workshop', since: 4 }]);
  assert.deepEqual(roomsWithNews(known, rooms, ['main', 'workshop']), [], 'both panes open: nothing elsewhere');
  assert.deepEqual(roomsWithNews(known, rooms, ['workshop']), [{ room: 'main', since: 10 }]);
});

test('a room seen for the first time, or known as empty, is only noted: the first list is history', () => {
  // The page shows an empty Main until the server's list comes; that jump is not a new message.
  assert.deepEqual(roomsWithNews(new Map([['main', 0]]), [{ id: 'main', last_id: 240 }, { id: 'new', last_id: 3 }], ['workshop']), []);
});

test('what is known only goes forward, and a room that is gone is dropped', () => {
  const known = knownAfter(new Map([['main', 12], ['gone', 5]]), [{ id: 'main', last_id: 0 }, { id: 'workshop', last_id: 4 }]);
  assert.deepEqual([...known], [['main', 12], ['workshop', 4]]);
  assert.deepEqual([...knownAfter(null, [{ id: 'main', last_id: 3 }])], [['main', 3]]);
});

test('from a room that is not open, only a message someone else addressed to you rings', () => {
  const notes = chordNotes(ROSTER);
  const cues = addressedCues([
    msg('claude', { recipient: 'david', room: 'workshop' }), // to you: rings
    msg('grok', { room: 'workshop' }), // to everyone: quiet
    msg('grok', { recipient: 'claude', room: 'workshop' }), // to someone else: quiet
    msg('david', { recipient: 'david', room: 'workshop' }), // from you: quiet
    msg('hub', { recipient: 'david', room: 'workshop' }), // not on the roster: quiet
  ], 'david', ROSTER);
  assert.deepEqual(cues, [{ kind: 'note', freq: notes.get('claude')!, addressed: true }]);
  assert.deepEqual(addressedCues([msg('claude', { recipient: 'david' })], null, ROSTER), [], 'no one signed in: nothing');
  // It is addressed, so it is heard even while the tab is hidden.
  assert.equal(audible(cues[0], true), true);
});

test('a new version chimes in a hidden tab too, and wins over a message that comes at the same time', () => {
  const hiddenTab = player({ hidden: true });
  hiddenTab.p.setOn(true); hiddenTab.p.wake();
  hiddenTab.p.offer({ kind: 'version' });
  vi.advanceTimersByTime(5000);
  assert.equal(hiddenTab.count(), 2, 'the two-note rise plays while the tab is hidden');

  const both = player();
  both.p.setOn(true); both.p.wake();
  both.p.offer(note());
  both.p.offer({ kind: 'version' });
  vi.advanceTimersByTime(5000);
  assert.equal(both.count(), 2, 'the version chime (two notes), not the single message note');
  vi.useRealTimers();
});

test('the reminder comes after 30 minutes', async () => {
  const { VERSION_REMINDER_MS } = await import('../app/sound');
  assert.equal(VERSION_REMINDER_MS, 30 * 60 * 1000);
});

test('«Waiting on you»: a low two-note fall, heard in a hidden tab, and it wins over a new version at the same moment', () => {
  const fake = fakeContext();
  createSoundEngine(fake.ctx).play({ kind: 'waiting' });
  const starts = [...new Set(fake.oscillators.map((o) => o.start))].sort();
  assert.equal(starts.length, 2, 'two notes, one after the other');
  const lowest = (t: number) => Math.min(...fake.oscillators.filter((o) => o.start === t).map((o) => o.freq));
  assert.ok(lowest(starts[1]) < lowest(starts[0]) && lowest(starts[0]) < D4, 'falling, and below the root D');

  const both = player({ hidden: true });
  both.p.setOn(true); both.p.wake();
  both.p.offer({ kind: 'version' });
  both.p.offer({ kind: 'waiting' });
  vi.advanceTimersByTime(5000);
  const lows = both.fake.oscillators.filter((o) => o.freq < D4).length;
  assert.ok(lows > 0, 'the knock played, not the version rise');
  vi.useRealTimers();
});
