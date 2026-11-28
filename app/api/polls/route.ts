import { waitUntil } from '@vercel/functions';
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parsePollInput } from '../../../lib/core';
import { authenticate, error, json, readJson, roomError, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { RoomError, getStore } from '../../../lib/store';
import { postGuardNotice } from '../../../lib/guard-hub';
import { notifyPushForMessage, schedulePush } from '../../../lib/push';
import { getWakeup } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/polls {"question": "...", "options": ["A", "B"], "to": "<name>", "room": "<id>"}
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
  let created;
  try {
    created = await store.createPoll({
      creator: me,
      question: input.question,
      options: input.options,
      recipient: input.recipient,
      room: input.room,
    });
  } catch (e) {
    if (e instanceof RoomError) return roomError(e);
    throw e;
  }
  if (!created) {
    return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
  }
  // The loop and cost guard: the hub's notice when this message trips it (lib/guard-hub.ts).
  await postGuardNotice(store, created.message);
  const job = getWakeup(store)?.onMessage(created.message);
  if (job) waitUntil(job);
  schedulePush(notifyPushForMessage(store, created.message));
  return json({ message: created.message, poll: created.poll }, 201);
});
