'use client';

// Work in flight: a thin strip under the header with what each participant is on right now, so the
// orchestrator sees who is busy (and need not interrupt), who waits, and who has gone quiet.
// Agents set their flight with `hub.js flight working "…"` (PUT /api/flight); the page reads it.
//   🟢 working · 🟡 waiting · ⚪ idle · 🔴 quiet: «working», but no message for 20 minutes.
// On a phone only the dots and names fit; a tap on a name shows its text as a tooltip (title).
// «⇅» moves the strip between the top and right above the message box, where the eyes are.
import { Fragment, useEffect, useRef, useState } from 'react';
import { HUB_WINDOW, REPO, messageHref, shortLabel, splitMessageRefs } from './links';
import { allMerged, useMergedPrs } from './merged';
import { flightSteps, waitingOn, type WaitOnHuman } from './waits';
import { FLIGHT_QUIET_MINUTES, colorOf, labelOf, type Flight, type Participant } from '../lib/shared';

export const FLIGHT_POLL_MS = 15_000;

/** Where the strip sits: under the header, or right above the message box. Kept in this browser. */
export type FlightPosition = 'top' | 'bottom';
export const FLIGHT_POSITION_KEY = 'trialogFlightPosition';
export function readFlightPosition(storage: Pick<Storage, 'getItem'> | undefined): FlightPosition {
  try { return storage?.getItem(FLIGHT_POSITION_KEY) === 'bottom' ? 'bottom' : 'top'; } catch { return 'top'; }
}
export function writeFlightPosition(storage: Pick<Storage, 'setItem'> | undefined, position: FlightPosition): void {
  try { storage?.setItem(FLIGHT_POSITION_KEY, position); } catch { /* private mode: it simply isn't kept */ }
}

export type FlightTone = 'working' | 'waiting' | 'idle' | 'quiet';

const MINUTE = 60_000;

/**
 * How a flight is shown. Working turns quiet once both the flight and the last message are older
 * than FLIGHT_QUIET_MINUTES: someone who just started is not quiet, however long ago they wrote.
 */
export function flightTone(f: Pick<Flight, 'state' | 'since' | 'last_message_at'>, now: number): FlightTone {
  if (f.state !== 'working') return f.state;
  const quietFor = FLIGHT_QUIET_MINUTES * MINUTE;
  const since = Date.parse(f.since);
  const last = f.last_message_at ? Date.parse(f.last_message_at) : Number.NEGATIVE_INFINITY;
  return now - since >= quietFor && now - last >= quietFor ? 'quiet' : 'working';
}

/** «4 min», «1 h 05», from `since` to now. Under a minute is «now». */
export function flightAge(since: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(since)) / MINUTE);
  if (!Number.isFinite(minutes) || minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

const DOT: Record<FlightTone, string> = { working: '#3fb950', waiting: '#d29922', idle: '#6e7681', quiet: '#f85149' };
const WORD: Record<FlightTone, string> = { working: 'working on', waiting: 'waiting for', idle: 'idle', quiet: 'quiet, last on' };

/** What a flight says in words, also for screen readers and the tooltip. */
export function flightSentence(f: Flight, now: number, shown: string): string {
  const tone = flightTone(f, now);
  if (tone === 'idle') return `${shown}: idle`;
  return `${shown}: ${WORD[tone]} «${f.text}» · ${flightAge(f.since, now)}`;
}

export { flightSteps, waitingOn, type WaitOnHuman } from './waits';

/** A participant named in a step, by name or label, for its colour. */
const named = (name: string, participants: readonly Participant[]): Participant | undefined =>
  participants.find((p) => p.name.toLowerCase() === name.toLowerCase() || (p.label ?? '').toLowerCase() === name.toLowerCase());

/** The flight's text with each «Name:» in that participant's colour (#743: Grok's step in his colour, not red). */
export function FlightStepsText({ text, participants = [], hidden = false }: { text: string; participants?: readonly Participant[]; hidden?: boolean }) {
  return <>{flightSteps(text).map((step, i) => {
    const who = step.name ? named(step.name, participants) : undefined;
    return (
      <Fragment key={i}>{i > 0 && '; '}{step.name && (who
        ? <span className="font-semibold" data-step-for={who.name} style={{ color: colorOf(who.name, participants) }}>{labelOf(who.name, participants)}: </span>
        : `${step.name}: `)}<FlightText text={step.text} hidden={hidden} /></Fragment>
    );
  })}</>;
}

/** A GitHub address as a short name: «PR 36» in this repo, «other-app PR 36» in another. */
export function flightLinkLabel(href: string, repo: string | null = REPO): string {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/.exec(href);
  if (!m) return shortLabel(href);
  const kind = m[3] === 'pull' ? 'PR' : 'issue';
  return repo && `${m[1]}/${m[2]}`.toLowerCase() === repo.toLowerCase() ? `${kind} ${m[4]}` : `${m[2]} ${kind} ${m[4]}`;
}

/** Flight text with its http(s) addresses as links, so «David: merge https://…/pull/36» opens that PR. */
export function FlightText({ text, hidden = false }: { text: string; hidden?: boolean }) {
  const parts = text.split(/(https?:\/\/[^\s<>«»"]+[^\s<>«»".,;:!?)])/);
  return <>{parts.map((p, i) => (i % 2
    ? <a key={i} href={p} tabIndex={hidden ? -1 : undefined} target="_blank" rel="noopener noreferrer" title={p} className="underline decoration-dotted underline-offset-2">{flightLinkLabel(p)}</a>
    : <Fragment key={i}>{splitMessageRefs(p).map((q, j) => (typeof q === 'string'
      ? q
      // «#936» in a note or a wait: the hub at that message (playground #970).
      : <a key={j} href={messageHref(q.id)} target={HUB_WINDOW} data-message-ref={q.id} tabIndex={hidden ? -1 : undefined} title={`Go to message ${q.typed}`} className="underline decoration-dotted underline-offset-2">{q.typed}</a>))}</Fragment>))}</>;
}

/** The words for a human's entry: what waits on them, or that nothing does. */
export function humanSentence(shown: string, waits: readonly WaitOnHuman[], participants: readonly Participant[] = []): string {
  if (!waits.length) return `${shown}: nothing waiting on you`;
  return `${shown}: waiting on you (${waits.length}): ${waits.map((w) => `${w.text} (${labelOf(w.by, participants)})`).join('; ')}`;
}

/** The strip. Nothing at all when nobody has set a flight. */
export function FlightStrip({ flights, now, participants = [], position = 'top', onFlip, merged }: { flights: readonly Flight[]; now: number; participants?: readonly Participant[]; position?: FlightPosition; onFlip?: () => void; merged?: ReadonlySet<number> }) {
  if (!flights.length) return null;
  return (
    <div data-position={position} className={`flex min-w-0 items-center gap-3 bg-[#1a1d25] px-4 py-1 text-[13px] ${position === 'top' ? 'border-b border-line' : 'border-t border-line'}`}>
      {/* The entries scroll sideways when they don't fit; «⇅» stays in view at the right. Only the
          entries are the live region, so the button isn't read out with every update. No scroll bar:
          with «always show scroll bars» it drew a grey bar above the message box (playground #695);
          a swipe, a trackpad or Shift+wheel still scrolls, as in the rooms' row. */}
      <div role="status" aria-label="Work in flight" className="flex min-w-0 flex-1 items-center gap-x-5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* The humans first: red and blinking while an agent waits on them (playground #578). */}
      {participants.filter((p) => p.kind === 'human').map((h) => {
        const waits = waitingOn(flights, h, merged);
        const shown = labelOf(h.name, participants);
        const sentence = humanSentence(shown, waits, participants);
        return (
          <span key={`human-${h.name}`} data-human={h.name} data-waiting={waits.length ? '' : undefined} title={sentence}
            // On a phone a wait takes the strip's width and wraps, so its link is never cut off.
            className={`inline-flex min-w-0 flex-none items-center gap-1.5 whitespace-nowrap ${waits.length ? 'max-sm:w-[calc(100vw-4.5rem)] max-sm:whitespace-normal' : ''}`}>
            {/* Waiting: the words are read as shown, so their links can be reached by keyboard too. */}
            {!waits.length && <span className="sr-only">{sentence}</span>}
            <span aria-hidden="true" className={`inline-block flex-none rounded-full ${waits.length ? 'h-2.5 w-2.5 blink-red' : 'h-2 w-2'}`} style={{ background: waits.length ? '#f85149' : DOT.idle }} />
            <span aria-hidden={waits.length ? undefined : true} className="font-semibold" style={{ color: colorOf(h.name, participants) }}>{shown}</span>
            {waits.length
              ? <span className="min-w-0 font-semibold text-[#ff7b72] sm:max-w-[60ch] sm:truncate">waiting on you ({waits.length}): {waits.map((w, i) => <Fragment key={i}>{i > 0 && ' · '}<FlightText text={w.text} /></Fragment>)}</span>
              : <span aria-hidden="true" className="text-muted max-sm:hidden">nothing waiting on you</span>}
          </span>
        );
      })}
      {flights.map((f) => {
        // A wait whose PRs are all merged is over, even if the agent hasn't said so yet (#856):
        // grey, «… merged», instead of «waiting for … PR 107».
        const over = f.state === 'waiting' && allMerged(f.text, merged ?? new Set());
        const tone = over ? 'idle' : flightTone(f, now);
        const shown = labelOf(f.participant, participants);
        const sentence = over ? `${shown}: «${f.text}» is merged` : flightSentence(f, now, shown);
        return (
          <span key={f.participant} data-flight={tone} title={sentence} className="inline-flex min-w-0 flex-none items-center gap-1.5 whitespace-nowrap">
            {/* The whole sentence for screen readers, also on a phone where the words are hidden. */}
            <span className="sr-only">{sentence}</span>
            <span aria-hidden="true" className="contents">
            <span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: DOT[tone] }} />
            <span className="font-semibold" style={{ color: colorOf(f.participant, participants) }}>{shown}</span>
            {tone !== 'idle' && (
              <>
                <span className="max-w-[32ch] truncate text-fg/90 max-sm:hidden">{WORD[tone]} «<FlightStepsText text={f.text} participants={participants} hidden />»</span>
                <span className="flex-none text-muted max-sm:hidden">· {flightAge(f.since, now)}</span>
              </>
            )}
            {tone === 'idle' && (over
              ? <span data-merged="" className="max-w-[32ch] truncate text-muted max-sm:hidden">«<FlightStepsText text={f.text} participants={participants} hidden />» merged</span>
              : <span className="text-muted max-sm:hidden">idle</span>)}
            </span>
          </span>
        );
      })}
      </div>
      {onFlip && (
        <button
          type="button" onClick={onFlip} data-flip=""
          title={position === 'top' ? 'Move this strip right above the message box' : 'Move this strip to the top'}
          aria-label={position === 'top' ? 'Move the work-in-flight strip above the message box' : 'Move the work-in-flight strip to the top'}
          className="flex-none cursor-pointer rounded border border-line bg-transparent px-1.5 text-xs leading-5 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >⇅</button>
      )}
    </div>
  );
}

/** Reads GET /api/flight every 15 s (and when the tab comes back), and moves the minutes on. */
export function FlightBar({ token, onUnauthorized, participants = [], position = 'top', onFlip }: { token: string; onUnauthorized: () => void; participants?: readonly Participant[]; position?: FlightPosition; onFlip?: () => void }) {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const onUnauthRef = useRef(onUnauthorized);
  onUnauthRef.current = onUnauthorized;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/flight', { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) { onUnauthRef.current(); return; }
        if (!res.ok) return;
        const data = (await res.json()) as { flights?: unknown };
        if (!cancelled && Array.isArray(data.flights)) { setFlights(data.flights as Flight[]); setNow(Date.now()); }
      } catch {
        // Offline for a moment: keep what was shown; the next poll tries again.
      }
    };
    void load();
    const poll = window.setInterval(() => { if (!document.hidden) void load(); }, FLIGHT_POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);

  const merged = useMergedPrs(token, flights.filter((f) => f.state === 'waiting').map((f) => f.text));
  return <FlightStrip flights={flights} now={now} participants={participants} position={position} onFlip={onFlip} merged={merged} />;
}
