'use client';

// Learn by doing: a short guided tour in the real page. Each step is one line that points at a real
// control, and it is done when the person really does it: the page reports its own actions here
// (note). The tour itself sends nothing to the server and wakes no one; what the person sends in a
// step is an ordinary message of theirs. Its progress is kept in this browser only (localStorage).
import { useCallback, useEffect, useRef, useState } from 'react';
import { colorOf, labelOf, whoToWake, type DecisionCard, type Participant, type Sender } from '../lib/shared';

export type TourStepId = 'everyone' | 'address' | 'quote' | 'react' | 'decide' | 'room';

export interface TourStep {
  id: TourStepId;
  /** A small sign for the step, in the progress row and the recap. */
  icon: string;
  /** Where the step points: CSS selectors, tried in order. The last visible match of the first that matches wins. */
  targets: readonly string[];
  /**
   * Where to look: in the leading pane only (with two rooms side by side, the left one), or in the
   * whole page (the room tabs in the header).
   */
  scope: 'pane' | 'page';
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'everyone', icon: '💬', targets: ['[data-tour="box"]'], scope: 'pane' },
  { id: 'address', icon: '@', targets: ['[data-tour="box"]'], scope: 'pane' },
  { id: 'quote', icon: '❝', targets: ['[data-message-text]'], scope: 'pane' },
  { id: 'react', icon: '☺', targets: ['button[aria-label="Add a reaction"]'], scope: 'pane' },
  // A card that waits for the person's Agree; without one, the Decision button makes one.
  { id: 'decide', icon: '⚖', targets: ['[data-tour="agree"]:not([aria-pressed="true"])', '[data-tour="decision"]'], scope: 'pane' },
  { id: 'room', icon: '#', targets: ['[data-tour="rooms"]'], scope: 'page' },
];

/** The line of a step. `agent` is the name of an agent to address, if there is one. */
export function stepText(id: TourStepId, agent: Sender | null): string {
  switch (id) {
    case 'everyone': return 'Say hello to everyone: write a line and press Enter.';
    case 'address': return agent ? `Now to one agent only: start the line with @${agent}.` : 'Now to one participant only: start the line with @ and their name.';
    case 'quote': return 'Select a few words in a message, then press Quote.';
    case 'react': return 'Press ☺ on a message and pick an emoji.';
    case 'decide': return 'Press Decision and ask a question, or press Agree on a card.';
    case 'room': return 'Open another room, or make one with +.';
  }
}

/** What this browser remembers of the tour, per participant. */
export interface TourState {
  /** The tour was offered once. It is not offered again; the «?» still opens it. */
  offered: boolean;
  /** The tour is on the page. Actions count only while it is. */
  open: boolean;
  /** «Don't show again» was pressed. */
  hidden: boolean;
  /** This participant has sent a message from this browser. */
  posted: boolean;
  done: TourStepId[];
  skipped: TourStepId[];
  /** Whom the «one agent» step went to, for the recap. */
  addressed: Sender | null;
}

export const NEW_TOUR: TourState = { offered: false, open: false, hidden: false, posted: false, done: [], skipped: [], addressed: null };

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export const tourKey = (me: Sender) => `trialogTour:${me}`;
const STEP_IDS = new Set<string>(TOUR_STEPS.map((s) => s.id));
const stepList = (value: unknown): TourStepId[] => (Array.isArray(value) ? [...new Set(value.filter((v): v is TourStepId => typeof v === 'string' && STEP_IDS.has(v)))] : []);

/** The stored tour of `me`. Anything broken or missing reads as a tour that never started. */
export function readTour(storage: Storage, me: Sender): TourState {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(tourKey(me)) ?? 'null'); } catch { return NEW_TOUR; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NEW_TOUR;
  const r = raw as Record<string, unknown>;
  return {
    offered: r.offered === true,
    open: r.open === true,
    hidden: r.hidden === true,
    posted: r.posted === true,
    done: stepList(r.done),
    skipped: stepList(r.skipped),
    addressed: typeof r.addressed === 'string' ? r.addressed : null,
  };
}

export function writeTour(storage: Storage, me: Sender, state: TourState): void {
  try { storage.setItem(tourKey(me), JSON.stringify(state)); } catch { /* storage is off or full: the tour forgets, nothing else breaks */ }
}

/** What the person did, as the page reports it once the server has taken it. */
export type TourEvent =
  | { kind: 'sent'; message: { sender: Sender; recipient: Sender | null } }
  | { kind: 'quoted' }
  | { kind: 'reacted' }
  | { kind: 'agreed' }
  | { kind: 'room' };

/**
 * Whether `me` has agreed on a card, as the server answered it. A card the human creates already
 * holds their Agree, so making one is the step too.
 */
export const agreedBy = (card: Pick<DecisionCard, 'positions'>, me: Sender): boolean =>
  card.positions.some((p) => p.participant === me && p.stance === 'agree');

/** The step an action completes, if any. A message to a human is not the «one agent» step. */
export function stepOf(event: TourEvent, roster: readonly Participant[]): TourStepId | null {
  switch (event.kind) {
    case 'sent': {
      const to = event.message.recipient;
      if (to === null) return 'everyone';
      return roster.some((p) => p.name === to && p.kind === 'agent') ? 'address' : null;
    }
    case 'quoted': return 'quote';
    case 'reacted': return 'react';
    case 'agreed': return 'decide';
    case 'room': return 'room';
  }
}

/** The tour after an action. A sent message is always remembered; steps count only while the tour is open, in any order. */
export function withEvent(state: TourState, event: TourEvent, roster: readonly Participant[]): TourState {
  const next = event.kind === 'sent' && !state.posted ? { ...state, posted: true } : state;
  if (!next.open) return next;
  const step = stepOf(event, roster);
  if (!step || next.done.includes(step)) return next;
  return {
    ...next,
    done: [...next.done, step],
    skipped: next.skipped.filter((s) => s !== step),
    addressed: step === 'address' && event.kind === 'sent' ? event.message.recipient : next.addressed,
  };
}

/** The step to do now: the first one neither done nor skipped. Null when all are through: the recap. */
export const currentStep = (state: TourState): TourStep | null =>
  TOUR_STEPS.find((s) => !state.done.includes(s.id) && !state.skipped.includes(s.id)) ?? null;

export const startTour = (s: TourState): TourState => ({ ...s, offered: true, open: true, hidden: false, done: [], skipped: [], addressed: null });
export const skipStep = (s: TourState): TourState => {
  const step = currentStep(s);
  return step ? { ...s, skipped: [...s.skipped, step.id] } : s;
};
export const hideTour = (s: TourState): TourState => ({ ...s, offered: true, open: false, hidden: true });
export const closeTour = (s: TourState): TourState => ({ ...s, open: false });
/** The «?»: closes an open tour; opens a closed one where it stopped, or from the start when it was through or never begun. */
export function toggleTour(s: TourState): TourState {
  if (s.open) return closeTour(s);
  const midway = currentStep(s) !== null && (s.done.length > 0 || s.skipped.length > 0);
  return midway ? { ...s, offered: true, open: true, hidden: false } : startTour(s);
}

/**
 * Whether to offer the tour: once, to a human who has never posted. "Never posted" is what this
 * browser knows (a message sent from it) and what the page holds (the latest messages of the room
 * that is open), so it is offered only once those have loaded.
 */
export function shouldOffer(state: TourState, { me, roster, loaded, history }: {
  me: Sender | null; roster: readonly Participant[]; loaded: boolean; history: readonly { sender: Sender }[];
}): boolean {
  if (!me || !loaded || state.offered || state.hidden || state.open || state.posted) return false;
  if (roster.find((p) => p.name === me)?.kind !== 'human') return false;
  return !history.some((m) => m.sender === me);
}

export type TourView = 'offer' | 'step' | 'recap' | null;

export interface Tour {
  view: TourView;
  state: TourState;
  step: TourStep | null;
  start: () => void;
  skip: () => void;
  hide: () => void;
  close: () => void;
  toggle: () => void;
  /** The page reports an action of the person here. Stable across renders. */
  note: (event: TourEvent) => void;
}

/** The tour of the participant signed in on this page. */
export function useTour({ me, participants, loaded, history }: {
  me: Sender | null; participants: readonly Participant[]; loaded: boolean; history: readonly { sender: Sender }[];
}): Tour {
  const [state, setState] = useState<TourState>(NEW_TOUR);
  const [readFor, setReadFor] = useState<Sender | null>(null); // whose tour `state` is
  const [offering, setOffering] = useState(false);
  const stateRef = useRef(state);
  const ownerRef = useRef<Sender | null>(null);
  const rosterRef = useRef(participants);
  rosterRef.current = participants;

  useEffect(() => {
    if (!me) return;
    ownerRef.current = me;
    const stored = readTour(localStorage, me);
    stateRef.current = stored;
    setState(stored);
    setReadFor(me);
    setOffering(false);
  }, [me]);

  const update = useCallback((change: (s: TourState) => TourState) => {
    const next = change(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    if (ownerRef.current) writeTour(localStorage, ownerRef.current, next);
    setState(next);
  }, []);

  const ready = readFor !== null && readFor === me;
  const offerNow = ready && shouldOffer(state, { me, roster: participants, loaded, history });
  useEffect(() => {
    if (!offerNow) return;
    setOffering(true);
    update((s) => ({ ...s, offered: true })); // offered once: a reload does not offer it again
  }, [offerNow, update]);

  const note = useCallback((event: TourEvent) => update((s) => withEvent(s, event, rosterRef.current)), [update]);
  const step = currentStep(state);
  let view: TourView = null;
  if (ready && state.open) view = step ? 'step' : 'recap';
  else if (ready && offering && !state.hidden && !state.posted) view = 'offer';

  return {
    view, state, step, note,
    start: () => { setOffering(false); update(startTour); },
    skip: () => update(skipStep),
    hide: () => { setOffering(false); update(hideTour); },
    close: () => { setOffering(false); update(closeTour); },
    toggle: () => { setOffering(false); update(toggleTour); },
  };
}

/** The leading pane: the left one when two rooms are side by side. The whole page if there is no pane. */
export const leadPane = (root: ParentNode = document): ParentNode => root.querySelector('[data-tour-pane="lead"]') ?? root;

/** The element a step points at: the last visible match of the first selector that has one. */
export function findTarget(selectors: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    const shown = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => el.getClientRects().length > 0);
    if (shown.length) return shown[shown.length - 1];
  }
  return null;
}

const TOUR_BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-2.5 py-[3px] text-[13px] hover:bg-[#343a47]';
const QUIET_BUTTON = 'cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-[3px] text-[13px] text-muted hover:text-fg';

/** The «?» next to the state of the page: opens and closes the tour. */
export function TourButton({ open, onToggle, className = '' }: { open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button" onClick={onToggle} aria-expanded={open} aria-label="Learn by doing: a guided tour" title="Learn by doing"
      className={`grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-full border border-line bg-transparent text-[11px] font-bold leading-none text-muted hover:border-accent hover:text-fg ${className}`}
    >?</button>
  );
}

/** The tour on the page: the offer, the step to do now, or the recap. Points at the control of the step. */
export function TourPanel({ tour, me, participants }: { tour: Tour; me: Sender | null; participants: readonly Participant[] }) {
  const section = useRef<HTMLElement>(null);
  const { view, step, state } = tour;
  const stepId = step?.id ?? null;

  // Points at the real control: a ring around it, for as long as the step is the current one.
  // Looked for after every render, because the control may appear later (a decision card).
  useEffect(() => {
    if (view !== 'step' || !step) return undefined;
    const target = findTarget(step.targets, step.scope === 'pane' ? leadPane() : document);
    if (!target) return undefined;
    target.setAttribute('data-tour-target', '');
    return () => target.removeAttribute('data-tour-target');
  });

  // A button that was pressed may be gone (Start, a finished step): the focus goes to the new line, not to the page's start.
  useEffect(() => {
    if (!view || !section.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return; // the focus is somewhere: leave it there
    section.current.querySelector<HTMLElement>('[data-tour-focus]')?.focus({ preventScroll: true });
  }, [view, stepId]);

  if (!view) return null;
  const agent = participants.find((p) => p.kind === 'agent' && p.name !== me)?.name ?? null;
  const hideButton = <button type="button" className={QUIET_BUTTON} onClick={tour.hide}>Don&apos;t show again</button>;

  return (
    <section ref={section} aria-label="Learn by doing" className="border-b border-line bg-[#141924] px-4 py-2 text-[13px]">
      {view === 'offer' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p tabIndex={-1} data-tour-focus className="m-0 min-w-0 flex-1 outline-none">
            <strong>Learn by doing.</strong> You are the human orchestrator here. Six small steps, right in this page.
          </p>
          <div className="flex gap-1.5">
            <button type="button" className={TOUR_BUTTON} onClick={tour.start}>Start</button>
            {hideButton}
          </div>
        </div>
      )}
      {view === 'step' && step && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <TourProgress state={state} current={step.id} />
          <p tabIndex={-1} data-tour-focus aria-live="polite" className="m-0 min-w-0 flex-1 outline-none">{stepText(step.id, agent)}</p>
          <div className="flex gap-1.5">
            <button type="button" className={TOUR_BUTTON} onClick={tour.skip}>Skip</button>
            {hideButton}
          </div>
        </div>
      )}
      {view === 'recap' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p tabIndex={-1} data-tour-focus aria-live="polite" className="m-0 min-w-0 flex-1 font-semibold outline-none">
              Done, {me ? labelOf(me, participants) : 'you'}. This is what you did.
            </p>
            <div className="flex gap-1.5">
              <button type="button" className={TOUR_BUTTON} onClick={tour.close}>Close</button>
              {hideButton}
            </div>
          </div>
          <TourRecap me={me} participants={participants} state={state} />
          <TourProgress state={state} current={null} />
          <a href="https://trialog.dev" target="_blank" rel="noopener noreferrer" className="self-start text-[13px]">How a message travels: trialog.dev</a>
        </div>
      )}
    </section>
  );
}

/** The six steps as small signs: done, skipped, the current one, and the ones still to come. */
export function TourProgress({ state, current }: { state: TourState; current: TourStepId | null }) {
  const at = current ? TOUR_STEPS.findIndex((s) => s.id === current) + 1 : null;
  return (
    <ol className="m-0 flex list-none items-center gap-1 p-0" aria-label={at ? `Step ${at} of ${TOUR_STEPS.length}` : 'The steps'}>
      {TOUR_STEPS.map((s) => {
        const done = state.done.includes(s.id);
        const skipped = state.skipped.includes(s.id);
        const now = s.id === current;
        const said = done ? 'done' : skipped ? 'skipped' : now ? 'now' : 'to come';
        return (
          <li
            key={s.id} title={said} data-step={s.id} data-state={said}
            className={`grid h-6 w-6 place-items-center rounded-full border text-[12px] leading-none ${
              done ? 'border-ok bg-ok/20 text-ok' : now ? 'border-accent text-fg' : skipped ? 'border-line text-muted line-through' : 'border-line text-muted opacity-60'
            }`}
          >
            <span aria-hidden="true">{done ? '✓' : s.icon}</span>
            <span className="sr-only">{`${s.id}: ${said}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

const ROW = 34;

/**
 * One small picture of what the person did: their dot, the path of their message to everyone, and
 * who it woke (by the same rule as the server, lib/shared.ts whoToWake). The line of the message
 * to one agent is drawn thicker. In the page's colours.
 */
export function TourRecap({ me, participants, state }: { me: Sender | null; participants: readonly Participant[]; state: TourState }) {
  if (!me) return null;
  const others = participants.filter((p) => p.name !== me);
  const woken = new Set(whoToWake({ sender: me, recipient: null }, participants));
  const height = Math.max(2, others.length) * ROW + 16;
  const from = { x: 44, y: height / 2 };
  const shown = (name: Sender) => labelOf(name, participants);
  const sentToEveryone = state.done.includes('everyone');
  const wokenNames = woken.size === 0 ? 'nobody' : [...woken].map(shown).join(', ');
  // Nothing sent to everyone (the step was skipped): the picture shows the rule, not what happened.
  const caption = sentToEveryone ? `${shown(me)} → everyone · ${wokenNames} woken` : `A message from ${shown(me)} to everyone wakes ${wokenNames}.`;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 340 ${height}`} className="block h-auto w-full max-w-[360px]" role="img" aria-label={caption}>
        {others.map((p, i) => {
          const y = 8 + i * ROW + ROW / 2 + (others.length < 2 ? ROW / 2 : 0);
          const color = colorOf(p.name, participants);
          const isWoken = woken.has(p.name);
          const addressed = state.addressed === p.name;
          return (
            <g key={p.name} data-participant={p.name} data-woken={isWoken ? 'yes' : 'no'}>
              {sentToEveryone && (
                <line x1={from.x + 12} y1={from.y} x2={214} y2={y} stroke={color} strokeWidth={addressed ? 3 : 1.5} strokeLinecap="round" className="tour-path" />
              )}
              {isWoken && <circle cx={228} cy={y} r={14} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="3 3" className="tour-woken" />}
              <circle cx={228} cy={y} r={9} fill={color} />
              <text x={248} y={y + 4} fontSize={12} style={{ fill: 'var(--color-fg)' }}>{shown(p.name)}</text>
              {isWoken && sentToEveryone && <text x={248} y={y + 16} fontSize={10} style={{ fill: 'var(--color-muted)' }}>woken</text>}
            </g>
          );
        })}
        <circle cx={from.x} cy={from.y} r={12} fill={colorOf(me, participants)} />
        <text x={from.x} y={from.y + 28} fontSize={12} textAnchor="middle" style={{ fill: 'var(--color-fg)' }}>{shown(me)}</text>
      </svg>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}
