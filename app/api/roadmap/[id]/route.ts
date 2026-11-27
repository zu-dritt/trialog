import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { loadRoster } from '../../../../lib/participants';
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
  const [body, bad] = await readJson(request, 4 * 1024);
  if (bad) return bad;
  const input = parseItemChange(body, loadRoster().participants.map((p) => p.name));
  if (!input.ok) return error(input.status, input.error);
  const item = await (await getStore()).updateRoadmapItem(id, input.change, me);
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
