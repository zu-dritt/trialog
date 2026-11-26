import { waitUntil } from '@vercel/functions';
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parseDecisionInput } from '../../../lib/core';
import { authenticate, error, json, readJson, roomError, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { ReplyTargetError, RoomError, getStore } from '../../../lib/store';
import { getWakeup } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/decisions {"prompt": "...", "to": "<name>", "reply_to": 45, "room": "<id>"}
// Creates a message and an attached decision card. The creator is the owner of the Bearer token;
// any "sender"/"from"/"participant"/"creator" in the body is ignored.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const { names } = loadRoster();
  const input = parseDecisionInput(body, names);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  let created;
  try {
    created = await store.createDecision({
      creator: me,
      prompt: input.prompt,
      recipient: input.recipient,
      reply_to: input.replyTo,
      room: input.room,
    }, names);
  } catch (e) {
    if (e instanceof ReplyTargetError) return error(400, e.message);
    if (e instanceof RoomError) return roomError(e);
    throw e;
  }
  if (!created) {
    return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
  }
  const job = getWakeup(store)?.onMessage(created.message);
  if (job) waitUntil(job);
  return json({ message: created.message, decision: created.decision }, 201);
});
