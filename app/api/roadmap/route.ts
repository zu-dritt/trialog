import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { parseNewItem, parseOrder } from '../../../lib/roadmap';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX = 4 * 1024;
const names = () => loadRoster().participants.map((p) => p.name);

// GET /api/roadmap → {items}: every card, by column (done, now, next, later) and position.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  return json({ items: await (await getStore()).listRoadmap() });
});

// POST /api/roadmap {"column": "next", "title": "…", "note": "…", "owner": "claude"} → a new card at the end of the column.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX);
  if (bad) return bad;
  const input = parseNewItem(body, names());
  if (!input.ok) return error(input.status, input.error);
  const item = await (await getStore()).addRoadmapItem({ column: input.column, title: input.title, note: input.note, owner: input.owner, by: me });
  return item ? json({ item }, 201) : error(409, 'The roadmap is full (200 cards). Remove some done cards first.');
});

// PUT /api/roadmap {"column": "next", "ids": ["rm_…", …]} → that column in the new order (every card once).
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX);
  if (bad) return bad;
  const input = parseOrder(body);
  if (!input.ok) return error(input.status, input.error);
  const items = await (await getStore()).reorderRoadmap(input.column, input.ids, me);
  return items ? json({ items }) : error(409, 'The cards changed in the meantime: «ids» must be exactly the cards now in that column. Reload and try again.');
});
