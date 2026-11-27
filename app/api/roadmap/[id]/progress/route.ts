import { authenticate, error, json, readJson, safe } from '../../../../../lib/http';
import { loadRoster } from '../../../../../lib/participants';
import { ROADMAP_ID, parseProgress } from '../../../../../lib/roadmap';
import { getStore } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/roadmap/<id>/progress {"progress": 60, "status": "geocoding done"} → the card.
// Only the card's owner (or a human) says how far it is; anyone else gets 409 with the owner.
export const PUT = safe(async (request: Request, ctx: Ctx) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  const [body, bad] = await readJson(request, 4 * 1024);
  if (bad) return bad;
  const input = parseProgress(body);
  if (!input.ok) return error(input.status, input.error);
  const human = loadRoster().participants.find((p) => p.name === me)?.kind === 'human';
  const result = await (await getStore()).setRoadmapProgress(id, me, input.progress, input.status, human);
  if (result.status === 'not_found') return error(404, 'No such card.');
  if (result.status === 'taken') return json({ error: result.owner ? `It is ${result.owner}'s card; only the owner says how far it is.` : 'Claim the card first.', owner: result.owner || null, item: result.item }, 409);
  return json({ item: result.status === 'ok' ? result.item : null });
});
