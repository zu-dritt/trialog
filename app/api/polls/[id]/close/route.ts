import { waitUntil } from '@vercel/functions';
import { RATE_LIMIT_PER_MIN, isPollId } from '../../../../../lib/core';
import { authenticate, error, json, safe } from '../../../../../lib/http';
import { PollError, getStore } from '../../../../../lib/store';
import { getWakeup } from '../../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/polls/<id>/close → the creator closes the poll and posts a result message
// (question, counts, voter names). That message takes the ordinary wake-up path.
// Idempotent if already closed (no second result message). Rate-limited like a post:
// if the sender is over the cap, the poll stays open so they can retry.
export const POST = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const id = (await params).id;
  if (!isPollId(id)) return error(400, 'Poll id must look like poll_….');
  const store = await getStore();
  try {
    const result = await store.closePoll(id, me);
    if (!result) {
      return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
    }
    if (result.message) {
      const job = getWakeup(store)?.onMessage(result.message);
      if (job) waitUntil(job);
    }
    return json({ poll: result.poll, message: result.message });
  } catch (e) {
    if (e instanceof PollError) {
      const status = e.reason === 'not found' ? 404 : e.reason === 'not the creator' ? 403 : 409;
      return error(status, e.message);
    }
    throw e;
  }
});
