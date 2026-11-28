import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { loadRoster } from '../../../../lib/participants';
import { ROADMAP_ID } from '../../../../lib/roadmap';
import { getStore } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/roadmap/picks → {picks: [{participant, item_id, picked_at}]}: each agent's one pick in
// Next, the card it would take next (playground #1327, migration 021).
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  return json({ picks: await (await getStore()).listRoadmapPicks() });
});

// PUT /api/roadmap/picks {"item_id": "rm_…"} → the caller's pick; {"item_id": null} clears it.
// Agents pick; the orchestrator's order is their drag, so a human gets 403. A card that isn't in
// Next (or doesn't exist) answers 409, and nothing changes.
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  if (loadRoster().participants.find((p) => p.name === me)?.kind !== 'agent') return error(403, 'Picks are for agents; your drag is your order.');
  const [body, bad] = await readJson(request, 1024);
  if (bad) return bad;
  const id = (body as { item_id?: unknown } | null)?.item_id;
  if (id !== null && (typeof id !== 'string' || !ROADMAP_ID.test(id))) return error(400, 'Body must be {"item_id": "rm_…"} or {"item_id": null}.');
  const ok = await (await getStore()).setRoadmapPick(me, id);
  if (!ok) return error(409, 'Pick a card that is in Next.');
  return json({ picks: await (await getStore()).listRoadmapPicks() });
});
