import { authenticate, error, json, safe } from '../../../../../lib/http';
import { getStore } from '../../../../../lib/store';
import { getWakeup } from '../../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// POST /api/wake/target/test
// Sends one signed test notice to the caller's registered target. The body is a wake-up with
// id 0 and a fixed preview, not a real message. The response never includes the secret or the URL.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const result = await getWakeup(store).sendTest(me);
  if (!result.ok) return error(result.error === 'No wake-up target is set.' ? 404 : 502, result.error);
  return json({ ok: true, status: result.status });
});
