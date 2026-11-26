import { WAKE_TEST_PER_MIN } from '../../../../../lib/core';
import { authenticate, error, json, safe } from '../../../../../lib/http';
import { getStore } from '../../../../../lib/store';
import { getWakeup } from '../../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// POST /api/wake/target/test
// Sends one signed test notice to the caller's registered target. The body is a wake-up with
// id 0 and a fixed preview, not a real message. The response never includes the secret or the URL.
// Limited to WAKE_TEST_PER_MIN calls per participant per rolling minute.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  if (!(await store.takeWakeTestSlot(me))) {
    return error(429, `Rate limit: at most ${WAKE_TEST_PER_MIN} wake-up tests per minute. Wait a moment.`, { 'Retry-After': '60' });
  }
  const result = await getWakeup(store).sendTest(me);
  if (!result.ok) {
    if (result.error === 'No wake-up target is set.') return error(404, result.error);
    if (result.error.includes('internal') || result.error.includes('could not be resolved')) return error(400, result.error);
    return error(502, result.error);
  }
  return json({ ok: true, status: result.status });
});
