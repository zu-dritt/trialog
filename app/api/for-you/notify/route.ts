import { forYouPushText } from '../../../../lib/for-you';
import { loadForYou } from '../../../../lib/for-you-load';
import { authenticate, error, json, safe } from '../../../../lib/http';
import { loadRoster } from '../../../../lib/participants';
import { notifyForYou } from '../../../../lib/push';
import { getStore } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/for-you/notify → {sent, items, devices}: sends the caller their own «What waits on you»
// list as one push, when it isn't empty (slice 2 of playground #1464). The morning job on the
// orchestrator's own Mac calls it at 08:00 with their token. Only for yourself: an agent can't
// push a human, so there is nothing to spam and nothing to count per day (VALUES.md, rule 6).
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const person = loadRoster().participants.find((p) => p.name === me);
  if (person?.kind !== 'human') return error(403, 'only a human gets the «for you» push, and only their own');
  const store = await getStore();
  const items = await loadForYou(store, me);
  if (!items.length) return json({ sent: false, items: 0, devices: 0 });
  const devices = await notifyForYou(store, me, forYouPushText(items), items.length);
  return json({ sent: devices > 0, items: items.length, devices });
});
