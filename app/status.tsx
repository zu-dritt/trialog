'use client';

import { useEffect, useRef, useState } from 'react';
import { colorOf, displayName, type Participant, type ParticipantStatus } from '../lib/shared';

export const STATUS_POLL_MS = 5_000;
export const STATUS_EXPIRY_TICK_MS = 1_000;
export const STATUS_MAX_FAILURES = 3;

/** Returns only statuses whose expires_at is strictly in the future relative to `now`. */
export function activeStatuses(statuses: ParticipantStatus[], now: number = Date.now()): ParticipantStatus[] {
  return statuses.filter((s) => {
    const exp = Date.parse(s.expires_at);
    return Number.isFinite(exp) && exp > now;
  });
}

/** Fetches active statuses using the Bearer token. Calls onUnauthorized on 401. */
export async function fetchStatuses(
  token: string,
  onUnauthorized: () => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ParticipantStatus[] | null> {
  try {
    const res = await fetchImpl('/api/status', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { statuses?: unknown };
    return Array.isArray(data.statuses) ? (data.statuses as ParticipantStatus[]) : [];
  } catch {
    return null;
  }
}

/**
 * Renders the active participant status line above the message composer. Each status is shown in
 * its participant's colour, which comes from `participants` (GET /api/participants); someone who
 * isn't on that list gets the neutral colour.
 */
export function StatusList({ statuses, now, participants = [] }: { statuses: ParticipantStatus[]; now?: number; participants?: readonly Participant[] }) {
  const active = activeStatuses(statuses, now);
  if (!active.length) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/70 bg-panel/60 px-4 py-1.5 text-xs"
    >
      {active.map((s) => (
        <span key={s.participant} className="inline-flex min-w-0 items-baseline gap-1" style={{ color: colorOf(s.participant, participants) }}>
          <span className="font-semibold">{displayName(s.participant)}:</span>
          <span className="max-w-[48ch] truncate opacity-90">{s.text}</span>
          <span aria-hidden="true" className="select-none">
            <span className="status-dot">.</span>
            <span className="status-dot status-dot-2">.</span>
            <span className="status-dot status-dot-3">.</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/** Polls GET /api/status on a light 5 s cadence and drops statuses locally when expires_at passes. */
export function StatusBar({ token, onUnauthorized, participants = [] }: { token: string; onUnauthorized: () => void; participants?: readonly Participant[] }) {
  const [statuses, setStatuses] = useState<ParticipantStatus[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const onUnauthRef = useRef(onUnauthorized);
  onUnauthRef.current = onUnauthorized;
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    failuresRef.current = 0;
    const load = async () => {
      const next = await fetchStatuses(token, () => onUnauthRef.current());
      if (cancelled) return;
      const current = Date.now();
      setNow(current);
      if (next !== null) {
        failuresRef.current = 0;
        setStatuses(activeStatuses(next, current));
      } else {
        failuresRef.current += 1;
        if (failuresRef.current >= STATUS_MAX_FAILURES) setStatuses([]);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, STATUS_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);

  useEffect(() => {
    if (!statuses.length) return undefined;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      setStatuses((prev) => {
        const next = activeStatuses(prev, current);
        return next.length === prev.length ? prev : next;
      });
    }, STATUS_EXPIRY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [statuses.length]);

  return <StatusList statuses={statuses} now={now} participants={participants} />;
}
