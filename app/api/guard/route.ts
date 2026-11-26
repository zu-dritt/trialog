import { activitySince, guardLimits, guardReport } from '../../../lib/guard';
import { authenticate, json, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/guard → the loop and cost guard (lib/guard.ts): the limits, the counts now, which limit
// holds wake-ups back (or null), agent messages per hour and agent for the last 24 hours, and how
// many pauses there were. Any participant may ask; it reads at most the last 25 hours of messages.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const now = Date.now();
  const rows = await store.recentActivity(activitySince(now));
  return json(guardReport(rows, loadRoster().participants, guardLimits(), now));
});
