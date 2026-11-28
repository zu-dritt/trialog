'use client';

// Which pull requests named on the page are already merged, so a «waiting on you: Ship it on PR 106»
// stops being red the moment the PR is in, without waiting for the agent to edit its note or flight
// (playground #813). Read through GET /api/pr/<n> (GitHub, cached five minutes on the server). A
// merged PR stays merged, so it is asked once; an open one again every OPEN_RECHECK_MS while shown.
import { useEffect, useRef, useState } from 'react';
import { ownPrs } from './waits';

export const OPEN_RECHECK_MS = 2 * 60_000;

export { allMerged, ownPrs, settledByMerge } from './waits';

/** The merged PRs among those named in `texts`. Without a token or a repository: none. */
export function useMergedPrs(token: string | null | undefined, texts: readonly string[]): ReadonlySet<number> {
  const [merged, setMerged] = useState<ReadonlySet<number>>(new Set());
  const checked = useRef(new Map<number, number>()); // PR → when last asked
  const wanted = [...new Set(texts.flatMap((t) => ownPrs(t)))].sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!token || !wanted) return undefined;
    let stopped = false;
    const ask = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      for (const n of wanted.split(',').map(Number)) {
        if (stopped) return;
        const at = checked.current.get(n);
        if (at !== undefined && (at === Infinity || now - at < OPEN_RECHECK_MS)) continue;
        checked.current.set(n, now);
        try {
          const res = await fetch(`/api/pr/${n}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) continue;
          const { summary } = (await res.json()) as { summary?: { state?: string } };
          if (summary?.state === 'merged') {
            checked.current.set(n, Infinity);
            if (!stopped) setMerged((m) => new Set(m).add(n));
          }
        } catch { /* offline for a moment: ask again later */ }
      }
    };
    void ask();
    const timer = setInterval(() => { void ask(); }, OPEN_RECHECK_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [token, wanted]);
  return merged;
}
