'use client';

// Which pull requests named on the page are already merged, so a «waiting on you: Ship it on PR 106»
// stops being red the moment the PR is in, without waiting for the agent to edit its note or flight
// (playground #813). Read through GET /api/pr/<n> (GitHub, cached five minutes on the server). A
// merged PR stays merged, so it is asked once; an open one again every OPEN_RECHECK_MS while shown.
import { useEffect, useRef, useState } from 'react';
import { REPO, REPO_PREFIXES, pullRequestNumbers } from './links';

export const OPEN_RECHECK_MS = 2 * 60_000;

/**
 * The PRs of this hub a text names. Another repository's PR is not ours (Grok's review of PR 108): an
 * address of another repo, or a repo name in front, «apartment-finder PR 36», is left out.
 */
export function ownPrs(text: string, repo: string | null = REPO, prefixes: Readonly<Record<string, string>> = REPO_PREFIXES): number[] {
  const ours = repo ? repo.toLowerCase() : '';
  const cleaned = text
    .replace(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/pull\/\d+/gi, (m, r: string) => (r.toLowerCase() === ours ? m : ' '))
    .replace(/(?:^|\s)[A-Za-z0-9_.]*[-/][A-Za-z0-9_./-]*\s+(?:PR|pull request)\s?#?\d+/gi, ' ');
  return pullRequestNumbers(cleaned, repo, prefixes);
}

/** True when the text names at least one PR of this hub and every one of them is merged. */
export function allMerged(text: string, merged: ReadonlySet<number>, repo: string | null = REPO): boolean {
  const prs = ownPrs(text, repo);
  return prs.length > 0 && prs.every((n) => merged.has(n));
}

/**
 * A wait on the orchestrator that a merge settles: it asks for a Ship it or a merge, and every PR it
 * names is merged. «Agree on decision card #791 (PR 101)» still waits, merged or not (Grok's review).
 */
export function settledByMerge(text: string, merged: ReadonlySet<number>, repo: string | null = REPO): boolean {
  return /ship it|\bmerge/i.test(text) && allMerged(text, merged, repo);
}

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
