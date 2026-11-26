import { waitUntil } from '@vercel/functions';
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parsePollInput } from '../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { getStore } from '../../../lib/store';
import { getWakeup } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/polls {"question": "...", "options": ["A", "B"], "to": "<name>"}
// Creates a message and an attached poll in one step. The creator is the owner of the Bearer token;
// any "sender"/"from"/"participant"/"creator" in the body is ignored.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parsePollInput(body, loadRoster().names);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  const created = await store.createPoll({
    creator: me,
    question: input.question,
    options: input.options,
    recipient: input.recipient,
  });
  if (!created) {
    return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
  }
  const job = getWakeup(store)?.onMessage(created.message);
  if (job) waitUntil(job);
  return json({ message: created.message, poll: created.poll }, 201);
});
