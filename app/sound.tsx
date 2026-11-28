'use client';

// Sound mode: each participant has a note of one chord, so you hear who wrote without looking.
// Everything is made in the browser with the Web Audio API: no audio files, no library.
//
//   a message from someone else      that sender's note, a soft bell with a tail
//   a message you sent               a short, soft confirmation
//   a reaction on your message       a tiny high tick
//   a decision card everyone agreed  the whole chord, once
//   «New version available»          a gentle two-note rise, also in a hidden tab, and once more
//                                    after 30 minutes if the page still has not been reloaded
//   «Waiting on you»                 a low knock-knock, two notes falling, also in a hidden tab: something
//                                    new joined your «⛔ n for you» list (playground #1414, #1493)
//
// It is off until switched on with the speaker button next to «● live», and the choice is kept in
// this browser. Browsers allow sound only after a click on the page, and that click is the button.
// At most one sound plays per second; what comes in between is skipped. While the tab is hidden,
// only a message addressed to you, an agreed decision and a new version are heard.
//
// The open rooms are heard in full. From a room that is not open, only a message addressed to you
// rings: the page reads what is new there when the list of rooms says a room has grown.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Sender } from '../lib/core';
import { decisionIsAgreed, type Participant, type Room } from '../lib/shared';

// --- the notes ---

/** D4, the root of the chord. Everything else is a number of semitones from it. */
const ROOT_HZ = 440 * 2 ** (-7 / 12);
const hz = (semitones: number) => ROOT_HZ * 2 ** (semitones / 12);
/** The humans get the root: the first one this D, a second one the D below, a third the D above. */
const ROOTS = [0, -12, 12];
/** Everyone else, in this order: third, fifth, seventh, ninth, sixth, and the same an octave up. */
const TONES = [4, 7, 11, 14, 9, 16, 19, 23, 26, 21, 28];

/**
 * Each participant's note, in hertz. Humans come first and get the root, agents get the third,
 * the fifth and further tones of the chord, each in the order of the roster the server sends
 * (`GET /api/participants`). The same roster always gives the same notes, and no two participants
 * share one (a hub has at most twelve; humans beyond the third take the next free tone after the agents).
 */
export function chordNotes(roster: readonly Pick<Participant, 'name' | 'kind'>[]): Map<Sender, number> {
  const notes = new Map<Sender, number>();
  const humans = roster.filter((p) => p.kind === 'human');
  const rest = [...roster.filter((p) => p.kind !== 'human'), ...humans.slice(ROOTS.length)];
  humans.slice(0, ROOTS.length).forEach((p, i) => notes.set(p.name, hz(ROOTS[i])));
  // A root no human took is free for the others, after the rest of the chord.
  const tones = [...TONES, ...ROOTS.slice(humans.length)];
  rest.forEach((p, i) => { if (i < tones.length) notes.set(p.name, hz(tones[i])); });
  return notes;
}

// --- what the page did, as sounds ---

export type Cue =
  | { kind: 'note'; freq: number; addressed: boolean } // a message from someone else
  | { kind: 'sent'; freq: number } // your own message went out
  | { kind: 'reaction' } // someone reacted to your message
  | { kind: 'agreed'; freqs: number[] } // a decision card everyone has agreed
  | { kind: 'version' } // «New version available»
  | { kind: 'waiting' }; // something new waits on you («⛔ n for you»)

/** Which cue wins when several arrive together (an agreement comes with the message that completed it). */
// A new version outranks an ordinary message, so it is not lost when both come at once.
// An addressed note ranks 3 (below); the new version ranks 3.5, so it wins that tie too.
// Something waiting on you ranks above a new version: it needs you, the version can wait.
const RANK: Record<Cue['kind'], number> = { agreed: 4, waiting: 3.75, version: 3.5, note: 2, sent: 2, reaction: 1 };
const rank = (cue: Cue) => RANK[cue.kind] + (cue.kind === 'note' && cue.addressed ? 1 : 0);

/** While the tab is hidden, only a message addressed to you, an agreed decision, a new version and a new wait on you are heard. */
export function audible(cue: Cue, hidden: boolean): boolean {
  return !hidden || cue.kind === 'agreed' || cue.kind === 'version' || cue.kind === 'waiting' || (cue.kind === 'note' && cue.addressed);
}

/** What the sounds need to know about the messages on the page, to tell what is new. */
export interface SoundSnapshot {
  /** The newest message id seen. Only a message above it is new; older ones loaded later are not. */
  maxId: number;
  /** Per message of mine: how many reactions others have left on it. */
  reactionsOnMine: Map<number, number>;
  /** Decision cards that were agreed at some point while the page was open. Each rings once. */
  agreed: Set<string>;
}

const reactionsByOthers = (m: Message, me: Sender) => (m.reactions ?? []).reduce((n, r) => n + r.by.filter((who) => who !== me).length, 0);
const isAgreed = (m: Message, names: readonly string[]) => Boolean(m.decision && (m.decision.agreed_at || decisionIsAgreed(m.decision, names)));

/** The state of `messages`, as the next comparison needs it. Agreed cards are kept from `before`. */
export function snapshotOf(messages: readonly Message[], me: Sender | null, names: readonly string[], before?: SoundSnapshot): SoundSnapshot {
  const reactionsOnMine = new Map<number, number>();
  const agreed = new Set(before?.agreed);
  let maxId = before?.maxId ?? 0;
  for (const m of messages) {
    maxId = Math.max(maxId, m.id);
    if (me && m.sender === me) reactionsOnMine.set(m.id, reactionsByOthers(m, me));
    if (m.decision && isAgreed(m, names)) agreed.add(m.decision.id);
  }
  return { maxId, reactionsOnMine, agreed };
}

/**
 * The sounds for what changed between `before` and `messages`. Never one for your own message
 * (that one is played when you send it), nor for a message that is older than what was on the
 * page, nor for a name that is not on the roster (the hub's welcome).
 */
export function soundCues(before: SoundSnapshot, messages: readonly Message[], me: Sender | null, roster: readonly Participant[]): Cue[] {
  const notes = chordNotes(roster);
  const names = roster.map((p) => p.name);
  const cues: Cue[] = [];
  for (const m of messages) {
    const isNew = m.id > before.maxId;
    if (isNew && m.sender !== me) {
      const freq = notes.get(m.sender);
      if (freq) cues.push({ kind: 'note', freq, addressed: Boolean(me) && m.recipient === me });
    }
    if (!isNew && me && m.sender === me && reactionsByOthers(m, me) > (before.reactionsOnMine.get(m.id) ?? Infinity)) cues.push({ kind: 'reaction' });
    if (m.decision && !before.agreed.has(m.decision.id) && isAgreed(m, names)) cues.push({ kind: 'agreed', freqs: names.map((n) => notes.get(n)).filter((f): f is number => Boolean(f)) });
  }
  return cues;
}

// --- rooms that are not open ---

/**
 * The rooms that are not open and have grown since `known`, each with the id to read after. A room
 * that `known` doesn't have yet, or knows as empty, is only noted: what it holds is history. (The
 * page shows an empty Main until the server's list arrives, so a jump from 0 is the list arriving,
 * not a new message. The price: the very first message of a room you don't have open stays quiet.)
 */
export function roomsWithNews(known: ReadonlyMap<string, number>, rooms: readonly Pick<Room, 'id' | 'last_id'>[], open: readonly string[]): { room: string; since: number }[] {
  const news: { room: string; since: number }[] = [];
  for (const r of rooms) {
    const before = known.get(r.id);
    if (before && r.last_id > before && !open.includes(r.id)) news.push({ room: r.id, since: before });
  }
  return news;
}

/** What `known` should say after `rooms`: each room's newest id, never going back. */
export function knownAfter(known: ReadonlyMap<string, number> | null, rooms: readonly Pick<Room, 'id' | 'last_id'>[]): Map<string, number> {
  const next = new Map<string, number>();
  for (const r of rooms) next.set(r.id, Math.max(r.last_id, known?.get(r.id) ?? 0));
  return next;
}

/** From a room that is not open: a note for each message that someone else addressed to you. */
export function addressedCues(messages: readonly Message[], me: Sender | null, roster: readonly Participant[]): Cue[] {
  if (!me) return [];
  const notes = chordNotes(roster);
  const cues: Cue[] = [];
  for (const m of messages) {
    const freq = m.recipient === me && m.sender !== me ? notes.get(m.sender) : undefined;
    if (freq) cues.push({ kind: 'note', freq, addressed: true });
  }
  return cues;
}

// --- the switch, remembered ---

export const SOUND_KEY = 'trialogSound';

/** Off unless this browser has switched it on. */
export function readSoundOn(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try { return storage?.getItem(SOUND_KEY) === 'on'; } catch { return false; }
}
export function writeSoundOn(storage: Pick<Storage, 'setItem'> | undefined, on: boolean): void {
  try { storage?.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* private mode: it holds until the reload */ }
}

// --- the sound itself ---

/** The part of the Web Audio API that is used here, so a test can hand in a fake. */
export type AudioContextLike = Pick<AudioContext, 'currentTime' | 'sampleRate' | 'state' | 'destination' | 'resume' | 'createGain' | 'createOscillator' | 'createConvolver' | 'createBuffer' | 'createDynamicsCompressor'>;

/** The whole mode stays this quiet: a chord at its loudest stays well below a full-scale signal. */
export const MASTER_GAIN = 0.22;
const REVERB_SECONDS = 1.8;
const REVERB_WET = 0.22;

/**
 * Bells and ticks on one context. A bell is a sine with a touch of its second and third harmonic,
 * slightly detuned pairs so it shimmers, a soft attack and a long fade; a small room made of
 * decaying noise adds the tail.
 */
export function createSoundEngine(ctx: AudioContextLike) {
  const out = ctx.createDynamicsCompressor(); // a safety net: nothing here should reach it
  out.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(out);
  const room = ctx.createConvolver();
  const length = Math.round(ctx.sampleRate * REVERB_SECONDS);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  room.buffer = impulse;
  const wet = ctx.createGain();
  wet.gain.value = REVERB_WET;
  room.connect(wet);
  wet.connect(master);

  /** One sine with an envelope: rises in `attack` seconds, then fades with time constant `decay`. */
  const partial = (freq: number, at: number, level: number, attack: number, decay: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level, at + attack);
    env.gain.setTargetAtTime(0, at + attack, decay);
    osc.connect(env);
    env.connect(master);
    env.connect(room);
    osc.start(at);
    osc.stop(at + attack + decay * 7); // by then it is below a ten-thousandth: no click at the end
  };
  const bell = (freq: number, at: number, level: number, decay: number) => {
    for (const [ratio, share, fade] of [[1, 1, 1], [2, 0.22, 0.55], [3, 0.06, 0.35]] as const) {
      partial(freq * ratio * 1.0012, at, level * share * 0.5, 0.008, decay * fade);
      partial(freq * ratio * 0.9988, at, level * share * 0.5, 0.008, decay * fade);
    }
  };

  return {
    play(cue: Cue) {
      const now = ctx.currentTime + 0.02;
      if (cue.kind === 'note') bell(cue.freq, now, 0.5, 0.42);
      else if (cue.kind === 'sent') bell(cue.freq * 2, now, 0.16, 0.09);
      else if (cue.kind === 'reaction') partial(hz(36), now, 0.07, 0.003, 0.025);
      else if (cue.kind === 'version') { bell(hz(7), now, 0.24, 0.24); bell(hz(12), now + 0.16, 0.24, 0.3); }
      // Low and short, falling, so it doesn't sound like the version's rise or anyone's note.
      else if (cue.kind === 'waiting') { bell(hz(-5), now, 0.34, 0.12); bell(hz(-12), now + 0.13, 0.34, 0.2); }
      else cue.freqs.forEach((freq, i) => bell(freq, now + i * 0.07, 0.46 / Math.sqrt(cue.freqs.length), 0.75));
    },
  };
}

/** Cues that arrive this close together are one moment: the most important one plays. */
export const GATHER_MS = 250;
/** At most one sound per this many milliseconds; what comes in between is skipped. */
export const MIN_GAP_MS = 1000;

export interface PlayerDeps {
  now: () => number;
  later: (ms: number, run: () => void) => void;
  hidden: () => boolean;
  /** Called only from a click or key press while the mode is on, as browsers require. */
  makeContext: () => AudioContextLike | null;
}

/**
 * Decides what is heard. Nothing is made, and no audio context exists, until the mode is on and
 * the page has had a click or key press (`wake`).
 */
export function createSoundPlayer(deps: PlayerDeps) {
  let on = false;
  let ctx: AudioContextLike | null = null;
  let engine: ReturnType<typeof createSoundEngine> | null = null;
  let pending: Cue | null = null;
  let last = -Infinity;
  const flush = () => {
    const cue = pending;
    pending = null;
    if (!cue || !on || !engine) return;
    const t = deps.now();
    if (t - last < MIN_GAP_MS) return;
    last = t;
    engine.play(cue);
  };
  return {
    get on() { return on; },
    /** Whether a context is running, so the page can stop listening for the first click. */
    get awake() { return ctx?.state === 'running'; },
    setOn(next: boolean) { on = next; if (!on) pending = null; },
    /** From a click or key press: make or resume the audio context. */
    wake() {
      if (!on) return;
      if (!ctx) {
        ctx = deps.makeContext();
        engine = ctx ? createSoundEngine(ctx) : null;
      }
      if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    },
    offer(cue: Cue) {
      if (!on || !audible(cue, deps.hidden())) return;
      if (pending && rank(pending) >= rank(cue)) return;
      const first = !pending;
      pending = cue;
      if (first) deps.later(GATHER_MS, flush);
    },
  };
}

// --- on the page ---

const makeBrowserContext = (): AudioContextLike | null => {
  const Ctor = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  return Ctor ? new Ctor() : null;
};

/**
 * Sound mode for the page. `primed` is false while a room's first messages are still coming in:
 * those are history, and are taken in without a sound.
 */
/** When the new-version chime sounds a second time, if the page has not been reloaded. */
export const VERSION_REMINDER_MS = 30 * 60 * 1000;

/** The new-version chime now and once more after VERSION_REMINDER_MS. Returns the way to cancel the second. */
export function versionChimes(offer: (cue: Cue) => void, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): () => void {
  offer({ kind: 'version' });
  const again = timers.set(() => offer({ kind: 'version' }), VERSION_REMINDER_MS);
  return () => timers.clear(again);
}

export function useSoundMode({ messages, me, participants, primed, newVersion }: {
  messages: readonly Message[];
  me: Sender | null;
  participants: readonly Participant[];
  primed: boolean;
  newVersion: boolean;
}) {
  const player = useRef<ReturnType<typeof createSoundPlayer> | null>(null);
  player.current ??= createSoundPlayer({
    now: () => performance.now(),
    later: (ms, run) => { setTimeout(run, ms); },
    hidden: () => document.visibilityState === 'hidden',
    makeContext: makeBrowserContext,
  });
  const [on, setOn] = useState(false);
  // The stored choice is read after the first render, so the server's markup and the page's agree.
  useEffect(() => {
    const stored = readSoundOn(window.localStorage);
    player.current!.setOn(stored);
    setOn(stored);
  }, []);
  // Switched on in an earlier visit: the browser needs a click or key press before any sound.
  useEffect(() => {
    if (!on) return undefined;
    const wake = () => {
      player.current!.wake();
      if (player.current!.awake) remove();
    };
    const remove = () => { window.removeEventListener('pointerdown', wake, true); window.removeEventListener('keydown', wake, true); };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    return remove;
  }, [on]);

  const toggle = useCallback(() => {
    const next = !player.current!.on;
    player.current!.setOn(next);
    writeSoundOn(window.localStorage, next);
    setOn(next);
    if (next) player.current!.wake(); // this click is the one the browser waits for
  }, []);

  const notes = useMemo(() => chordNotes(participants), [participants]);
  const names = useMemo(() => participants.map((p) => p.name), [participants]);
  const snapshot = useRef<SoundSnapshot | null>(null);
  const wasPrimed = useRef(false);
  useEffect(() => {
    // While a room loads, and in the moment it is loaded, only take note of what is there.
    if (!primed || !wasPrimed.current || !snapshot.current) {
      wasPrimed.current = primed;
      snapshot.current = snapshotOf(messages, me, names, primed ? snapshot.current ?? undefined : undefined);
      return;
    }
    const cues = soundCues(snapshot.current, messages, me, participants);
    snapshot.current = snapshotOf(messages, me, names, snapshot.current);
    for (const cue of cues) player.current!.offer(cue);
  }, [messages, me, names, participants, primed]);

  // The pill appeared while the page was open.
  // The chime when a new version is out, and once more after 30 minutes if the page is still old.
  useEffect(() => (newVersion ? versionChimes((cue) => player.current!.offer(cue)) : undefined), [newVersion]);

  /** Your own message went out. */
  const sent = useCallback(() => {
    player.current!.offer({ kind: 'sent', freq: (me && notes.get(me)) || ROOT_HZ });
  }, [me, notes]);

  /** Messages from a room that is not open: only those addressed to you ring. */
  const elsewhere = useCallback((list: readonly Message[]) => {
    for (const cue of addressedCues(list, me, participants)) player.current!.offer(cue);
  }, [me, participants]);

  /** Something new joined your «⛔ n for you» list. */
  const waiting = useCallback(() => { player.current!.offer({ kind: 'waiting' }); }, []);

  return { on, toggle, sent, elsewhere, waiting };
}

/**
 * Listens beyond the open rooms. When a room that is not open grows, its new messages are read and
 * handed to `heard`. Only while sound mode is on: otherwise nothing is fetched.
 */
export function useRoomsElsewhere({ on, rooms, open, me, api, heard }: {
  on: boolean;
  rooms: readonly Room[];
  open: readonly string[];
  me: Sender | null;
  api: (path: string) => Promise<Response>;
  heard: (messages: readonly Message[]) => void;
}) {
  const known = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!me) { known.current = null; return; }
    const before = known.current;
    known.current = knownAfter(before, rooms);
    if (!before || !on) return;
    for (const { room, since } of roomsWithNews(before, rooms, open)) {
      void api(`/api/messages?${new URLSearchParams({ room, since: String(since), limit: '50' })}`)
        .then((res) => (res.ok ? (res.json() as Promise<{ messages: Message[] }>) : null))
        .then((data) => { if (data) heard(data.messages); }, () => { /* the next message tries again */ });
    }
  }, [on, rooms, open, me, api, heard]);
}

export const SOUND_ON_HINT = 'Sound mode is on: each voice has its own note. Click to switch it off.';
export const SOUND_OFF_HINT = 'Sound mode is off. Click to hear who writes.';

/** The speaker button next to «● live». One button, pressed when the mode is on. */
export function SoundToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button" onClick={onToggle} aria-pressed={on} aria-label="Sound mode" title={on ? SOUND_ON_HINT : SOUND_OFF_HINT}
      className={`-ml-1.5 inline-flex flex-none cursor-pointer items-center rounded border-none bg-transparent p-1 hover:text-fg ${on ? 'text-fg' : 'text-muted'}`}
    >
      {/* A small speaker, drawn: with two waves when on, crossed out when off. Nothing in it moves. */}
      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor" fillOpacity={on ? 0.25 : 0} />
        {on
          ? <path d="M10.4 5.8a3 3 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8" />
          : <path d="M10.5 6l3.5 4M14 6l-3.5 4" />}
      </svg>
    </button>
  );
}
