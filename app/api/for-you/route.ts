import { loadForYou } from '../../../lib/for-you-load';
import { authenticate, json, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/for-you → {items: [{kind, key, text, href, since, message?}]}: what waits on the caller
// right now (lib/for-you.ts): decisions to answer, roadmap cards and agents' flights that wait on
// them. Built from the hub's own data, oldest first; nothing is stored.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  return json({ items: await loadForYou(await getStore(), me) });
});
