import { parseReadInput } from '../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { ReadError, getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_READ_BODY_BYTES = 4 * 1024;

// PUT /api/read {"upTo": 45}
// Sets the caller's read position to this message id if it is higher than the one they already
// have. A lower id is accepted and left unchanged. The participant comes from the Bearer token.
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_READ_BODY_BYTES);
  if (bad) return bad;
  const input = parseReadInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  try {
    const read = await store.setReadPosition(me, input.upTo);
    return json({ read });
  } catch (e) {
    if (e instanceof ReadError) return error(404, e.message);
    throw e;
  }
});
