import { isPollId } from '../../../../../lib/core';
import { authenticate, error, json, safe } from '../../../../../lib/http';
import { PollError, getStore } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/polls/<id>/close → the creator closes the poll. Idempotent if already closed.
export const POST = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const id = (await params).id;
  if (!isPollId(id)) return error(400, 'Poll id must look like poll_….');
  const store = await getStore();
  try {
    const poll = await store.closePoll(id, me);
    return json({ poll });
  } catch (e) {
    if (e instanceof PollError) {
      const status = e.reason === 'not found' ? 404 : e.reason === 'not the creator' ? 403 : 409;
      return error(status, e.message);
    }
    throw e;
  }
});
