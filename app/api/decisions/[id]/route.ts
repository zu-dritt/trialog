import { waitUntil } from '@vercel/functions';
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, isDecisionId, parseDecisionPosition } from '../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { loadRoster } from '../../../../lib/participants';
import { DecisionError, getStore } from '../../../../lib/store';
import { postGuardNotice } from '../../../../lib/guard-hub';
import { notifyPushForMessage, schedulePush } from '../../../../lib/push';
import { getWakeup } from '../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fail(e: unknown): Response {
  if (e instanceof DecisionError) {
    return error(e.reason === 'not found' ? 404 : 400, e.message);
  }
  throw e;
}

// PUT /api/decisions/<id> {"stance": "agree"|"object", "note"?}
// Records or changes the caller's Agree or Object. The participant comes from the token;
// any "participant" in the body is ignored. A note is optional for Agree and required for Object.
export const PUT = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const id = (await params).id;
  if (!isDecisionId(id)) return error(400, 'Decision id must look like decision_….');
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parseDecisionPosition(body);
  if (!input.ok) return error(input.status, input.error);
  const { names } = loadRoster();
  const store = await getStore();
  try {
    const result = await store.recordDecisionPosition(id, me, input.stance, input.note, names);
    if (result.status === 'rate_limited') {
      return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
    }
    if (result.reply) {
      // The loop and cost guard: the hub's notice when this message trips it (lib/guard-hub.ts).
      await postGuardNotice(store, result.reply);
      const job = getWakeup(store)?.onMessage(result.reply);
      if (job) waitUntil(job);
      schedulePush(notifyPushForMessage(store, result.reply));
    }
    return json({ decision: result.decision, message: result.message, reply: result.reply });
  } catch (e) {
    return fail(e);
  }
});
