'use client';

// "A newer version of the page has been deployed while this one was open." The page says so with
// a small pill in its header, directly after the "● live" indicator, so that everything about the
// state of the page reads in one spot. It is quiet: an outline, text of the same size and weight
// as "live", nothing that moves or blinks, and no green in it, because green there already means
// "the stream is connected". A click reloads the page. The page never reloads by itself: an
// unsent message, an open picker or a half-read thread is the reader's to give up, not the
// page's. (An unsent message is kept across the reload anyway.)
import { useEffect, useState } from 'react';

/** What a click on the pill does, as its tooltip says it. */
export const NEW_VERSION_HINT = 'Reload to get the newest version. Your unsent message is kept.';
/** A pill that has been waiting this long gets a slightly stronger outline. */
export const ACCENT_AFTER_MS = 60 * 60 * 1000;

/** Runs something once after a while. Returns the way to call it off. */
export function after(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

/** Whether something has been waiting for longer than `ms` without a break. */
export function useWaitingLong(waiting: boolean, ms: number = ACCENT_AFTER_MS): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => (waiting ? after(ms, () => setLong(true)) : undefined), [waiting, ms]);
  return waiting && long;
}

/**
 * The pill. It is rendered only when the server runs another build than the page was loaded with.
 *   accent     it has been waiting for a long time: the outline takes the highlight colour
 *   className  where the page puts it
 */
export function NewVersionPill({ onReload, accent = false, className = '' }: { onReload: () => void; accent?: boolean; className?: string }) {
  return (
    <button
      type="button" onClick={onReload} title={NEW_VERSION_HINT} aria-label={`New version available. ${NEW_VERSION_HINT}`}
      className={`inline-flex flex-none cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border bg-transparent px-2 text-[13px] text-fg hover:bg-panel ${accent ? 'border-david' : 'border-muted/50'} ${className}`.trimEnd()}
    >
      {/* A small reload arrow, drawn. */}
      <svg aria-hidden="true" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 6a4 4 0 1 1-1.2-2.85M10 1.6v2h-2" />
      </svg>
      New version available
    </button>
  );
}
