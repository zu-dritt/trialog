import { authenticate, error, json, safe } from '../../../../lib/http';
import { prSummary } from '../../../../lib/pr-summary';
import { repoOf } from '../../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/pr/<n> → {summary}: the pull request's title, state, author and first lines, for the
// hovercard on «PR n» (lib/pr-summary.ts). Only for this hub's TRIALOG_REPO.
export const GET = safe(async (request: Request, { params }: { params: Promise<{ n: string }> }) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const repo = repoOf(process.env.TRIALOG_REPO);
  const { n } = await params;
  if (!repo || !/^\d{1,6}$/.test(n)) return error(404, 'No such pull request.');
  try {
    const found = await prSummary(repo, Number(n));
    return found ? json({ summary: found.summary }) : error(404, 'No such pull request.');
  } catch (e) {
    return error(502, e instanceof Error ? e.message : 'GitHub could not be read.');
  }
});
