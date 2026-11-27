'use client';

// Work in flight: a thin strip under the header with what each participant is on right now, so the
// orchestrator sees who is busy (and need not interrupt), who waits, and who has gone quiet.
// Agents set their flight with `hub.js flight working "…"` (PUT /api/flight); the page reads it.
//   🟢 working · 🟡 waiting · ⚪ idle · 🔴 quiet: «working», but no message for 20 minutes.
// On a phone only the dots and names fit; a tap on a name shows its text as a tooltip (title).
// «⇅» moves the strip between the top and right above the message box, where the eyes are.
import { useEffect, useRef, useState } from 'react';
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

/** The strip. Nothing at all when nobody has set a flight. */
export function FlightStrip({ flights, now, participants = [], position = 'top', onFlip }: { flights: readonly Flight[]; now: number; participants?: readonly Participant[]; position?: FlightPosition; onFlip?: () => void }) {
  if (!flights.length) return null;
  return (
    <div role="status" aria-label="Work in flight" data-position={position} className={`flex min-w-0 items-center gap-3 bg-[#1a1d25] px-4 py-1 text-[13px] ${position === 'top' ? 'border-b border-line' : 'border-t border-line'}`}>
      {/* The entries scroll sideways when they don't fit; «⇅» stays in view at the right. */}
      <div className="flex min-w-0 flex-1 items-center gap-x-5 overflow-x-auto">
      {flights.map((f) => {
        const tone = flightTone(f, now);
        const shown = labelOf(f.participant, participants);
        const sentence = flightSentence(f, now, shown);
        return (
          <span key={f.participant} data-flight={tone} title={sentence} className="inline-flex min-w-0 flex-none items-center gap-1.5 whitespace-nowrap">
            {/* The whole sentence for screen readers, also on a phone where the words are hidden. */}
            <span className="sr-only">{sentence}</span>
            <span aria-hidden="true" className="contents">
            <span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: DOT[tone] }} />
            <span className="font-semibold" style={{ color: colorOf(f.participant, participants) }}>{shown}</span>
            {tone !== 'idle' && (
              <>
                <span className="max-w-[32ch] truncate text-fg/90 max-sm:hidden">{WORD[tone]} «{f.text}»</span>
                <span className="flex-none text-muted max-sm:hidden">· {flightAge(f.since, now)}</span>
              </>
            )}
            {tone === 'idle' && <span className="text-muted max-sm:hidden">idle</span>}
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
          className="flex-none cursor-pointer rounded border border-line bg-transparent px-1.5 text-xs leading-5 text-muted hover:text-fg"
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

  return <FlightStrip flights={flights} now={now} participants={participants} position={position} onFlip={onFlip} />;
}
