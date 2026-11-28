// Today's merged pull requests, for the «PRs today: n/100» chip (playground #1357, #1359).
// The count is the number of pull requests merged into the repository since midnight
// Europe/Zurich, any base branch: that is the number Claude and Grok used for the day's goal.
// Merges are read with the same GitHub helper as the streak (lib/streak.ts, TRIALOG_REPO, optional
// TRIALOG_GITHUB_TOKEN), cached for one minute so the chip stays live without hammering GitHub.
// Nothing is stored. Without a repository, or when GitHub is out of reach and there is no last
// list, there is no count and the chip stays hidden.

import { repoOf } from '../app/links';
import { cachedMerges, type Merge } from './streak';

export const PRS_TODAY_GOAL = 100;
export const PRS_TODAY_CACHE_MS = 60_000;
export const PRS_TODAY_TZ = 'Europe/Zurich';

export interface PrsTodayReport {
  count: number | null;
  goal: number;
  /** The calendar day in Europe/Zurich that was counted, «YYYY-MM-DD». */
  day: string;
  repo: string | null;
  /** Why the count could not be read, or null. A last good list still yields a count. */
  problem: string | null;
}

/** The calendar day of `at` in `timeZone`, as «YYYY-MM-DD». */
export function dayInZone(at: Date | number | string, timeZone: string = PRS_TODAY_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** How many of `merges` have a `merged_at` on the same calendar day as `now` in `timeZone`. */
export function countMergesOnDay(merges: readonly Merge[], now: Date | number, timeZone: string = PRS_TODAY_TZ): number {
  const day = dayInZone(now, timeZone);
  let n = 0;
  for (const m of merges) {
    const t = Date.parse(m.merged_at);
    if (!Number.isFinite(t)) continue;
    if (dayInZone(t, timeZone) === day) n += 1;
  }
  return n;
}

/** The chip's label, «PRs today: 28/100». */
export function prsTodayLabel(count: number, goal: number = PRS_TODAY_GOAL): string {
  return `PRs today: ${count}/${goal}`;
}

/**
 * Today's merge count for TRIALOG_REPO, using the shared GitHub cache (one minute here).
 * `base` is left open so merges into any branch count.
 */
export async function loadPrsToday(
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<PrsTodayReport> {
  const goal = PRS_TODAY_GOAL;
  const day = dayInZone(now);
  const repo = repoOf(env.TRIALOG_REPO);
  if (!repo) {
    return { count: null, goal, day, repo: null, problem: 'No repository is set (TRIALOG_REPO), so today\'s merges cannot be counted.' };
  }
  const { merges, problem } = await cachedMerges(repo, null, now, fetchImpl, PRS_TODAY_CACHE_MS);
  if (problem && merges.length === 0) return { count: null, goal, day, repo, problem };
  return { count: countMergesOnDay(merges, now), goal, day, repo, problem };
}
