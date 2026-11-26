import { MAX_BODY_BYTES, parseSince } from '../../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../../lib/http';
import { getStore } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/messages/<id>/pin {"pinned": true|false}  (any participant may pin)
export const POST = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const id = parseSince((await params).id);
  if (id === null || id === undefined) return error(400, 'Message id must be a whole number.');
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const pinned = (body as { pinned?: unknown } | null)?.pinned;
  if (typeof pinned !== 'boolean') return error(400, 'Body must be {"pinned": true} or {"pinned": false}.');
  const store = await getStore();
  const message = await store.setPinned(id, pinned);
  if (!message) return error(404, `No message #${id}.`);
  return json({ message, pinned: await store.pinned() });
});
