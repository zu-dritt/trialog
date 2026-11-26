'use client';

// "This message is a decision" and "this message is pinned" are two things, and each has its own
// sign. A decision is a message its writer began with DECISION: (after an optional @name). It gets
// a badge with the word written out. Pinning is what the pin button does, to any message.
//
// The badge is a word in a label, with a check mark drawn as part of it. It is deliberately not
// an emoji: a participant may answer a message with a check-mark emoji, and that must never look
// like the mark of a decision.
import { isDecision } from '../lib/decision';

// The rule itself lives in lib/decision.ts, so the server's search can use the very same one.
export { isDecision };

/** What to call the list at the top, which holds every pinned message. */
export function pinnedListTitle(pinned: { text: string }[], names: readonly string[]): 'Decisions' | 'Decisions and pinned' | 'Pinned' {
  const decisions = pinned.filter((m) => isDecision(m.text, names)).length;
  if (decisions === pinned.length) return 'Decisions';
  return decisions === 0 ? 'Pinned' : 'Decisions and pinned';
}

/** The badge: a small label with a drawn check mark and the word. */
export function DecisionBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex flex-none items-center gap-1 rounded border border-decision/60 bg-decision/10 px-1.5 align-baseline text-[11px] font-bold uppercase leading-[1.5] tracking-[.06em] text-decision ${className}`.trimEnd()}>
      <svg aria-hidden="true" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 6.5l2.6 2.6L10 3.4" />
      </svg>
      Decision
    </span>
  );
}
