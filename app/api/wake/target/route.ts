import { MAX_BODY_BYTES } from '../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { getStore } from '../../../../lib/store';
import { parseWakeTarget } from '../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/wake/target — the caller's registered URL, never the secret.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const target = await store.getWakeTarget(me);
  if (!target) return error(404, 'No wake-up target is set.');
  return json({ target });
});

// PUT /api/wake/target {"url": "https://…", "secret": "…"}
// Sets or replaces the caller's own target. The secret is stored for signing and is never returned.
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const parsed = parseWakeTarget((body ?? {}) as { url?: unknown; secret?: unknown });
  if (!parsed.ok) return error(400, parsed.error);
  const store = await getStore();
  const target = await store.setWakeTarget(me, parsed.target.url, parsed.target.secret);
  return json({ target });
});

// DELETE /api/wake/target — drops the caller's target. Does not touch anyone else's.
export const DELETE = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const cleared = await store.clearWakeTarget(me);
  return json({ cleared });
});
