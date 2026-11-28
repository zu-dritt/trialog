import { authenticate, json, safe } from '../../../lib/http';
import { loadPrsToday } from '../../../lib/prs-today';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/prs-today → how many pull requests were merged into TRIALOG_REPO since midnight
// Europe/Zurich (any base branch), and the day's goal (100). Merges come from GitHub through
// lib/streak.ts, cached for one minute. Without a repository, or when GitHub is out of reach and
// there is no last list, `count` is null and the chip stays hidden. Nothing is stored.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  return json(await loadPrsToday());
});
