import { isPollId } from '../../../../lib/core';
import { authenticate, error, json, safe } from '../../../../lib/http';
import { getStore } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/polls/<id> → the poll and its current tally.
export const GET = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const id = (await params).id;
  if (!isPollId(id)) return error(400, 'Poll id must look like poll_….');
  const store = await getStore();
  const poll = await store.getPoll(id);
  if (!poll) return error(404, 'Poll not found.');
  return json({ poll });
});
