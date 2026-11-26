import { MAX_BODY_BYTES, isPollId, parseVoteInput } from '../../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../../lib/http';
import { PollError, getStore } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fail(e: unknown): Response {
  if (e instanceof PollError) {
    const status = e.reason === 'not found' ? 404 : e.reason === 'closed' ? 409 : e.reason === 'not the creator' ? 403 : 400;
    return error(status, e.message);
  }
  throw e;
}

// POST /api/polls/<id>/vote {"option": 1}
// Records or changes the caller's vote. The voter is the owner of the Bearer token;
// any "participant" in the body is ignored.
export const POST = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const id = (await params).id;
  if (!isPollId(id)) return error(400, 'Poll id must look like poll_….');
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parseVoteInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  try {
    const poll = await store.vote(id, me, input.option);
    return json({ poll });
  } catch (e) {
    return fail(e);
  }
});

// DELETE /api/polls/<id>/vote → withdraws the caller's vote.
export const DELETE = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const id = (await params).id;
  if (!isPollId(id)) return error(400, 'Poll id must look like poll_….');
  const store = await getStore();
  try {
    return json(await store.unvote(id, me));
  } catch (e) {
    return fail(e);
  }
});
