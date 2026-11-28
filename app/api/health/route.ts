import { healthReport } from '../../../lib/health';
import { authenticate, json, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { getStore } from '../../../lib/store';
import { cachedMerges, streakBase } from '../../../lib/streak';
import { repoOf } from '../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/health → for each agent: the heartbeat (green under 10 minutes since its last message,
// status or flight, amber from 10, grey from 20), the one-word flight state, whether it waits on a
// human, and its last merged pull request (lib/health.ts). It is worked out from what the hub already
// keeps, so nothing is stored. Merges come from GitHub for TRIALOG_REPO (cached five minutes); without
// it, or when GitHub is out of reach, `last_merge` is null.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const repo = repoOf(process.env.TRIALOG_REPO);
  const [flights, statuses, merged] = await Promise.all([
    store.listFlights(),
    store.listStatuses(),
    repo ? cachedMerges(repo, streakBase()) : Promise.resolve({ merges: [], problem: null }),
  ]);
  return json(healthReport({ roster: loadRoster().participants, flights, statuses, merges: merged.merges, repo, now: Date.now() }));
});
