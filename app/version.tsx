'use client';

// "A newer version of the page has been deployed while this one was open." The page says so with
// a small pill in its header, at the right, always in the same place, like the one a desktop
// browser shows in its toolbar when an update is waiting. It is quiet: it does not move, blink or
// cover anything. A click reloads the page. The page never reloads by itself: an unsent message,
// an open picker or a half-read thread is the reader's to give up, not the page's. (An unsent
// message is kept across the reload anyway.)

/** What a click on the pill does, as its tooltip says it. */
export const NEW_VERSION_HINT = 'Reload to get the newest version. Your unsent message is kept.';

/** The pill. It is rendered only when the server runs another build than the page was loaded with. */
export function NewVersionPill({ onReload, className = '' }: { onReload: () => void; className?: string }) {
  return (
    <button
      type="button" onClick={onReload} title={NEW_VERSION_HINT} aria-label={`New version available. ${NEW_VERSION_HINT}`}
      className={`inline-flex flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-ok/50 bg-ok/10 px-3 py-[3px] text-[13px] font-semibold text-ok hover:bg-ok/20 ${className}`.trimEnd()}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ok" />
      New version available
    </button>
  );
}
