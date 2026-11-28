import { waitUntil } from '@vercel/functions';
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parseDecisionInput } from '../../../lib/core';
import { MAIN_ROOM } from '../../../lib/shared';
import { authenticate, error, json, readJson, roomError, roomFromQuery, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { ReplyTargetError, RoomError, getStore } from '../../../lib/store';
import { postGuardNotice } from '../../../lib/guard-hub';
import { notifyPushForMessage, schedulePush } from '../../../lib/push';
import { getWakeup } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;


// GET /api/decisions?room=<id>|all
// Every decision card, with the message's recipient and room, so the status-bar chip can show
// those still waiting on the caller (playground #1186, #1188). Without `room`, every room.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const [room, noRoom] = await roomFromQuery(new URL(request.url).searchParams, store, null);
  if (noRoom) return noRoom;
  const cards = await store.listDecisions(room);
  const messages = await store.listMessagesByIds(cards.map((c) => c.message_id));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const decisions = cards.map((decision) => {
    const m = byId.get(decision.message_id);
    return { decision, recipient: m?.recipient ?? null, room: m?.room ?? MAIN_ROOM };
  });
  return json({ me, decisions });
});

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
  // The loop and cost guard: the hub's notice when this message trips it (lib/guard-hub.ts).
  await postGuardNotice(store, created.message);
  const job = getWakeup(store)?.onMessage(created.message);
  if (job) waitUntil(job);
  schedulePush(notifyPushForMessage(store, created.message));
  return json({ message: created.message, decision: created.decision }, 201);
});
