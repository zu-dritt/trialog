import { authenticate, error, json, readJson, safe } from '../../../../../lib/http';
import { ROADMAP_ID, movesToNow, parseClaim } from '../../../../../lib/roadmap';
import { getStore } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// POST /api/roadmap/<id>/claim {"note": "exists, small fix"} → the card, now the caller's.
// A lock: the first claim wins. A card that is someone else's answers 409 with its owner, and
// nothing changes. Claiming your own card again only updates the note. The note says what the
// claimer found when looking first: «exists, small fix» or «new».
export const POST = safe(async (request: Request, ctx: Ctx) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  const [body, bad] = await readJson(request, 4 * 1024);
  if (bad) return bad;
  const input = parseClaim(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  const result = await store.claimRoadmapItem(id, me, input.note);
  if (result.status === 'not_found') return error(404, 'No such card.');
  if (result.status === 'taken') return json({ error: `Already ${result.owner}'s. Nothing changed.`, owner: result.owner, item: result.item }, 409);
  if (result.status === 'done') return json({ error: 'This card is done; there is nothing to claim.', item: result.item }, 409);
  if (result.status === 'busy') return json({ error: 'The card changed while you claimed it. Try again.', item: result.item }, 409);
  // A claimed card is being built: into Now, if it isn't there yet (house rule, playground #1081).
  const item = movesToNow(result.item) ? (await store.updateRoadmapItem(id, { column: 'now' }, me)) ?? result.item : result.item;
  return json({ item });
});

// DELETE /api/roadmap/<id>/claim → let go of a card you own (owner back to none).
export const DELETE = safe(async (request: Request, ctx: Ctx) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  const result = await (await getStore()).releaseRoadmapItem(id, me);
  if (result.status === 'not_found') return error(404, 'No such card.');
  if (result.status === 'taken') return json({ error: `It is ${result.owner}'s, not yours.`, owner: result.owner, item: result.item }, 409);
  if (result.status === 'done') return json({ item: result.item });
  return json({ item: result.item });
});
