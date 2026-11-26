'use client';

// Read markers on the page: initials at the last message each other participant has read,
// a subtle flag on a message that no addressed agent has seen after two minutes, and the
// hook that records the highest visible message while the tab is focused.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { colorOf, displayName, UNSEEN_AFTER_MS, UNSEEN_LABEL, unseenByAgents, type Participant, type ReadPosition, type Sender } from '../lib/shared';
import type { Message } from '../lib/core';

export { applyReads, UNSEEN_LABEL, UNSEEN_AFTER_MS, unseenByAgents } from '../lib/shared';

/** Small initials at the last message this person has read. Hidden for the viewer themselves. */
export function ReadReceipts({
  messageId,
  reads,
  participants,
  me,
}: {
  messageId: number;
  reads: readonly ReadPosition[];
  participants: readonly Participant[];
  me: Sender | null;
}) {
  const here = reads.filter((r) => r.up_to === messageId && r.participant !== me);
  if (!here.length) return null;
  return (
    <ul className="mt-1 mb-0 flex list-none flex-wrap items-center gap-0.5 p-0" aria-label="Who has read up to here">
      {here.map((r) => {
        const name = displayName(r.participant);
        const initial = name[0] ?? '?';
        return (
          <li key={r.participant}>
            <span
              className="inline-grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold text-bg"
              style={{ backgroundColor: colorOf(r.participant, participants) }}
              title={`${name} has read up to here`}
              aria-label={`${name} has read up to here`}
            >
              {initial}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The subtle flag on a message addressed to agents that none of them have read after two minutes. */
export function UnseenFlag({
  message,
  reads,
  participants,
  now,
}: {
  message: Pick<Message, 'id' | 'sender' | 'recipient' | 'created_at'>;
  reads: readonly ReadPosition[];
  participants: readonly Participant[];
  now: number;
}) {
  if (!unseenByAgents(message, reads, participants, now)) return null;
  return <p className="mb-0 mt-1 text-xs text-muted">{UNSEEN_LABEL}</p>;
}

/**
 * A clock that only advances when a message is about to cross the two-minute line, so the
 * "not seen yet" flag can appear without a busy interval.
 */
export function useUnseenClock(messages: readonly { created_at: string }[], nowFn: () => number = Date.now): number {
  const [now, setNow] = useState(nowFn);
  useEffect(() => {
    const soonest = messages
      .map((m) => Date.parse(m.created_at) + UNSEEN_AFTER_MS)
      .filter((at) => at > nowFn())
      .sort((a, b) => a - b)[0];
    if (soonest === undefined) return undefined;
    const wait = Math.max(0, Math.min(soonest - nowFn() + 25, 60_000));
    const timer = setTimeout(() => setNow(nowFn()), wait);
    return () => clearTimeout(timer);
  }, [messages, now, nowFn]);
  return now;
}

/**
 * Records the highest message id currently visible in `containerRef`, while the tab is visible
 * and the window is focused. A lower id is never reported. Re-observes when `messageIds` change.
 */
export function useVisibleReadMarker(
  containerRef: RefObject<HTMLElement | null>,
  messageIds: readonly number[],
  enabled: boolean,
  onUpTo: (id: number) => void,
): void {
  const onUpToRef = useRef(onUpTo);
  onUpToRef.current = onUpTo;
  const sent = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const root = containerRef.current;
    if (!root) return undefined;

    const visible = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let max = 0;
      for (const id of visible) if (id > max) max = id;
      if (max > sent.current) {
        sent.current = max;
        onUpToRef.current(max);
      }
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 400);
    };

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const raw = (entry.target as HTMLElement).id;
        const id = raw.startsWith('m-') ? Number(raw.slice(2)) : NaN;
        if (!Number.isInteger(id) || id <= 0) continue;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      schedule();
    }, { root, threshold: 0 });

    for (const node of root.querySelectorAll<HTMLElement>('article[id^="m-"]')) observer.observe(node);

    const onActivity = () => schedule();
    document.addEventListener('visibilitychange', onActivity);
    window.addEventListener('focus', onActivity);
    window.addEventListener('blur', onActivity);
    schedule();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onActivity);
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('blur', onActivity);
    };
  }, [containerRef, enabled, messageIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps -- observe when the set of ids changes, not when a new array is allocated
}
