import { authenticate, json, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/participants → who takes part here, in the order of the PARTICIPANTS setting, and who you are.
// {"me": "ana", "participants": [{"name": "ana", "kind": "human", "color": 0}, …]}
// `color` is an index into the page's palette of twelve colours. Tokens are never part of the answer.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  // Each field is copied by name, so nothing else about a participant can end up in the answer.
  const participants = loadRoster().participants.map(({ name, kind, color }) => ({ name, kind, color }));
  return json({ me, participants });
});
