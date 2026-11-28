// The streak: pull requests merged in a row without the orchestrator stepping in. A merge adds one;
// a break («I stepped in», or an agent saying honestly that it needed the orchestrator to unblock)
// ends the streak, with a one-line reason kept for the retro. The merges are read from GitHub
// (TRIALOG_REPO, public API, cached for five minutes); the breaks are stored in the hub.
//
// Only merges into TRIALOG_STREAK_BASE count (default «playground»), where the reviewer merges on
// green CI by our rules, so a merge there already means a reviewed, checked pull request.

export const STREAK_REASON_MAX_LENGTH = 200;
export const STREAK_CACHE_MS = 5 * 60_000;
const MAX_PAGES = 5;

/** `branch` is the pull request's own branch (head), when GitHub says; «claude/push-logs» shows who wrote it. */
export interface Merge { number: number; title: string; merged_at: string; branch?: string }
export interface StreakBreak { id: number; participant: string; reason: string; created_at: string }

/** One point of the timeline: the streak right after a merge or a break. */
export interface StreakPoint { at: string; value: number; record: number; pr?: number; break?: { by: string; reason: string; ended: number } }

export interface StreakReport {
  repo: string | null;
  base: string;
  current: number;
  record: number;
  record_at: string | null;
  points: StreakPoint[];
  /** Why merges could not be read (no repository set, GitHub unreachable), or null. */
  problem: string | null;
}

/** The branch whose merges count. */
export function streakBase(env: Record<string, string | undefined> = process.env): string {
  const v = env.TRIALOG_STREAK_BASE?.trim();
  return v && /^[A-Za-z0-9._/-]{1,100}$/.test(v) ? v : 'playground';
}

/**
 * Walks merges and breaks in time order. The streak grows by one per merge and drops to zero on a
 * break; the record is the highest it has been. A break at the same moment as a merge comes after it.
 */
export function computeStreak(merges: readonly Merge[], breaks: readonly StreakBreak[]): Omit<StreakReport, 'repo' | 'base' | 'problem'> {
  type Ev = { at: string; t: number; kind: 0 | 1; merge?: Merge; brk?: StreakBreak };
  const events: Ev[] = [
    ...merges.map((m): Ev => ({ at: m.merged_at, t: Date.parse(m.merged_at), kind: 0, merge: m })),
    ...breaks.map((b): Ev => ({ at: b.created_at, t: Date.parse(b.created_at), kind: 1, brk: b })),
  ].filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t || a.kind - b.kind);
  let current = 0;
  let record = 0;
  let recordAt: string | null = null;
  const points: StreakPoint[] = [];
  for (const e of events) {
    if (e.merge) {
      current += 1;
      if (current > record) { record = current; recordAt = e.at; }
      points.push({ at: e.at, value: current, record, pr: e.merge.number });
    } else if (e.brk) {
      points.push({ at: e.at, value: 0, record, break: { by: e.brk.participant, reason: e.brk.reason, ended: current } });
      current = 0;
    }
  }
  return { current, record, record_at: recordAt, points };
}

/** «I stepped in: …»: a plain line of 1–200 characters. */
export function parseStreakBreak(body: unknown): { ok: true; reason: string } | { ok: false; status: number; error: string } {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as { reason?: unknown }).reason : undefined;
  if (typeof raw !== 'string') return { ok: false, status: 400, error: `Body must be {"reason": "..."} (1–${STREAK_REASON_MAX_LENGTH} characters): why the orchestrator had to step in.` };
  const reason = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!reason || /[\x00-\x1f\x7f]/.test(reason)) return { ok: false, status: 400, error: '"reason" must be a non-empty line of plain text.' };
  if ([...reason].length > STREAK_REASON_MAX_LENGTH) return { ok: false, status: 400, error: `"reason" must be at most ${STREAK_REASON_MAX_LENGTH} characters.` };
  return { ok: true, reason };
}

/**
 * Optional: a GitHub token (read-only is enough) lifts the limit from 60 to 5,000 requests an hour.
 * TRIALOG_GITHUB_TOKEN; without it the public API is used.
 */
export function githubHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.TRIALOG_GITHUB_TOKEN?.trim();
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'trialog-hub', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** Merged pull requests, oldest first (up to 500). `base` limits the list to that branch; `null` reads every base. */
export async function fetchMerges(repo: string, base: string | null, fetchImpl: typeof fetch = fetch, headers: Record<string, string> = githubHeaders()): Promise<Merge[]> {
  const merges: Merge[] = [];
  const baseQ = base ? `&base=${encodeURIComponent(base)}` : '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=closed${baseQ}&per_page=100&page=${page}`;
    const res = await fetchImpl(url, { headers, cache: 'no-store' });
    if (res.status === 403 || res.status === 429) throw new Error(`GitHub's hourly limit is reached (${res.status}); set TRIALOG_GITHUB_TOKEN to raise it`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error('GitHub answered something that is not a list');
    for (const r of rows as { number?: unknown; title?: unknown; merged_at?: unknown; head?: { ref?: unknown } | null }[]) {
      if (typeof r.number === 'number' && typeof r.merged_at === 'string') {
        const branch = typeof r.head?.ref === 'string' ? r.head.ref : undefined;
        merges.push({ number: r.number, title: String(r.title ?? ''), merged_at: r.merged_at, ...(branch ? { branch } : {}) });
      }
    }
    if (rows.length < 100) break;
  }
  return merges.sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at));
}

const cache = new Map<string, { at: number; merges: Merge[] }>();

/** fetchMerges with a cache per repository and branch (`maxAge`, default five minutes); on a failure the last good list is used. */
export async function cachedMerges(repo: string, base: string | null, now = Date.now(), fetchImpl: typeof fetch = fetch, maxAge = STREAK_CACHE_MS): Promise<{ merges: Merge[]; problem: string | null }> {
  const key = `${repo}\0${base ?? ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < maxAge) return { merges: hit.merges, problem: null };
  try {
    const merges = await fetchMerges(repo, base, fetchImpl);
    cache.set(key, { at: now, merges });
    return { merges, problem: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : 'unknown error';
    return { merges: hit?.merges ?? [], problem: `Could not read merges from GitHub (${why}).${hit ? ' Showing the last list.' : ''}` };
  }
}

/** For tests: forget the cached lists. */
export function clearStreakCache(): void { cache.clear(); }
