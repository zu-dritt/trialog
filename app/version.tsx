'use client';

// A quiet note that a newer version of the page has been deployed while this one was open. It
// offers a Reload button and never reloads by itself: an unsent message, an open picker or a
// half-read thread is the reader's to give up, not the page's. (The text of an unsent message is
// kept across a reload anyway.) The note can be put away; it comes back only for yet another build.

export function NewVersionNotice({ onReload, onDismiss }: { onReload: () => void; onDismiss: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 border-b border-line bg-panel px-4 py-1.5 text-[13px]">
      <span className="min-w-0 flex-1">A newer version of Trialog is available.</span>
      <button
        type="button" onClick={onReload} title="Load the newer version. The text of an unsent message is kept."
        className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[3px] font-semibold hover:bg-[#343a47]"
      >Reload</button>
      <button
        type="button" onClick={onDismiss} aria-label="Dismiss this note" title="Dismiss this note"
        className="cursor-pointer rounded border-none bg-transparent px-1 text-base leading-none text-muted hover:text-fg"
      >×</button>
    </div>
  );
}

/**
 * Whether to show the note: the server reports another build than the page's own, and the reader
 * has not put the note away for that very build.
 */
export function showNewVersion(pageBuild: string, serverBuild: string | null, dismissedBuild: string | null, isOther: (a: unknown, b: unknown) => boolean): boolean {
  return isOther(pageBuild, serverBuild) && serverBuild !== dismissedBuild;
}
