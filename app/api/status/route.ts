import { parseStatusInput } from '../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_STATUS_BODY_BYTES = 4 * 1024;

// GET /api/status → active (non-expired) statuses for all participants.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const statuses = await store.listStatuses();
  return json({ statuses });
});

// PUT /api/status {"text": "reviewing pull request 7", "ttlSeconds": 300}
// Sets the caller's own status only (participant comes from the Bearer token).
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_STATUS_BODY_BYTES);
  if (bad) return bad;
  const input = parseStatusInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  const status = await store.setStatus({ participant: me, text: input.text, ttlSeconds: input.ttlSeconds });
  return json({ status });
});

// DELETE /api/status → clears the caller's own status.
export const DELETE = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const cleared = await store.clearStatus(me);
  return json({ cleared });
});
