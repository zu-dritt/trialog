import { authenticate, json, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';
import { cachedMerges, computeStreak, streakBase, type StreakReport } from '../../../lib/streak';
import { repoOf } from '../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/streak → the streak now, the record, and the timeline of merges and breaks (lib/streak.ts).
// Merges are read from GitHub for TRIALOG_REPO; without it there is only the list of breaks.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const breaks = await store.listStreakBreaks();
  const repo = repoOf(process.env.TRIALOG_REPO);
  const base = streakBase();
  const { merges, problem } = repo ? await cachedMerges(repo, base) : { merges: [], problem: 'No repository is set (TRIALOG_REPO), so merges cannot be counted.' };
  const report: StreakReport = { repo, base, problem, ...computeStreak(merges, breaks) };
  return json(report);
});
