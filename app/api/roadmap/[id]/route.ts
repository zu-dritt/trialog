import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { loadRoster } from '../../../../lib/participants';
import { notifyPushForRoadmap, schedulePush } from '../../../../lib/push';
import { ROADMAP_ID, parseItemChange } from '../../../../lib/roadmap';
import { getStore } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/roadmap/<id> {"column": "done"} | {"title", "note", "owner"} → the changed card. A new column puts it at the end there.
export const PATCH = safe(async (request: Request, ctx: Ctx) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  // Room for a full description (4000 characters, up to 4 bytes each) with its title and note.
  const [body, bad] = await readJson(request, 20 * 1024);
  if (bad) return bad;
  const roster = loadRoster().participants;
  const input = parseItemChange(body, roster.map((p) => p.name));
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  const before = (await store.listRoadmap()).find((i) => i.id === id) ?? null;
  const { owner, ...rest } = input.change;
  // The orchestrator may hand a card to anyone. An agent changes the owner only through the claim
  // lock: take a free card, or let go of its own, never overwrite someone else's claim.
  if (owner !== undefined && roster.find((p) => p.name === me)?.kind !== 'human') {
    if (owner !== null && owner !== me) return error(403, 'Agents take cards for themselves only: use POST /api/roadmap/<id>/claim.');
    const result = owner === me ? await store.claimRoadmapItem(id, me, null) : await store.releaseRoadmapItem(id, me);
    if (result.status === 'not_found') return error(404, 'No such card.');
    if (result.status === 'taken') return json({ error: `Already ${result.owner}'s. Nothing changed.`, owner: result.owner, item: result.item }, 409);
    if (result.status === 'done' && owner === me) return json({ error: 'This card is done; there is nothing to claim.', item: result.item }, 409);
    if (result.status === 'busy') return json({ error: 'The card changed while you claimed it. Try again.', item: result.item }, 409);
    if (!Object.keys(rest).length) {
      schedulePush(notifyPushForRoadmap(store, result.item, before));
      return json({ item: result.item });
    }
  }
  const change = owner !== undefined && roster.find((p) => p.name === me)?.kind === 'human' ? input.change : rest;
  const item = await store.updateRoadmapItem(id, change, me);
  if (item) schedulePush(notifyPushForRoadmap(store, item, before));
  return item ? json({ item }) : error(404, 'No such card.');
});

// DELETE /api/roadmap/<id> → {deleted}.
export const DELETE = safe(async (request: Request, ctx: Ctx) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  const deleted = await (await getStore()).deleteRoadmapItem(id);
  return deleted ? json({ deleted }) : error(404, 'No such card.');
});
