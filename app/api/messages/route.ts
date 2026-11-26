import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parseLimit, parseMessageInput, parseRecipient, parseSince, recipientHint } from '../../../lib/core';
import { authenticate, error, json, readJson, roomError, roomFromQuery, safe } from '../../../lib/http';
import { SEARCH_LIMIT, parseQuery } from '../../../lib/search';
import { waitUntil } from '@vercel/functions';
import { loadRoster } from '../../../lib/participants';
import { AttachmentLinkError, ReadError, ReplyTargetError, RoomError, getStore } from '../../../lib/store';
import { getWakeup } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Room for the wake-up webhook job after the response: 2 s debounce plus three attempts of up to 5 s.
export const maxDuration = 60;

/** A switch in the query, such as `decisions=1`. Left out or 0: off. */
function parseSwitch(value: string | null): boolean | undefined {
  if (value === null || value === '' || value === '0' || value === 'false') return false;
  return value === '1' || value === 'true' ? true : undefined;
}

// GET /api/messages?since=<id>&to=<name>&limit=<n>&room=<id>
// Without `since`: the latest messages. With `since`: messages with a higher id, oldest first.
// Always includes the pinned decisions and who you are (derived from your token).
// Without `room`: the room `main`. Messages and pinned decisions are those of the one room.
// `room=all`: every room at once, each message saying which room it is in.
//
// GET /api/messages?q=<words>&to=<name>&decisions=1&pinned=1&limit=<n>&room=<id>
// Search: the messages that contain every word, newest first, as {me, messages}.
// Without `room`, a search looks in every room; each message says which room it is in.
// decisions=1: only decisions (DECISION: or an agreed card; pinned or not). pinned=1: only pinned ones.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const since = parseSince(params.get('since'));
  if (since === undefined) return error(400, '"since" must be a message id (a whole number).');
  const { names } = loadRoster();
  const to = parseRecipient(params.get('to'), names);
  if (to === undefined) return error(400, recipientHint(names));
  const q = params.get('q');
  const limit = parseLimit(params.get('limit') || (q === null ? null : String(SEARCH_LIMIT)));
  if (limit === undefined) return error(400, '"limit" must be a whole number.');
  const store = await getStore();
  if (q !== null) {
    const query = parseQuery(q);
    if (!query.ok) return error(400, query.error);
    if (since !== null) return error(400, '"since" cannot be combined with "q": a search returns the newest matches first.');
    const decisions = parseSwitch(params.get('decisions'));
    if (decisions === undefined) return error(400, '"decisions" must be 1 or 0.');
    const pinned = parseSwitch(params.get('pinned'));
    if (pinned === undefined) return error(400, '"pinned" must be 1 or 0.');
    const [searched, noRoom] = await roomFromQuery(params, store, null);
    if (noRoom) return noRoom;
    return json({ me, messages: await store.search({ words: query.words, to, decisionsAmong: decisions ? names : null, pinned, limit, room: searched }) });
  }
  const [room, noRoom] = await roomFromQuery(params, store);
  if (noRoom) return noRoom;
  // The top-level polls, reactions, decisions and reads lists are opt-in (`?polls=1`, `?reactions=1`, `?decisions=1`,
  // `?reads=1`). The page asks for them so a since-poll still sees votes, reactions, decision-card changes and read
  // positions on older messages; the CLI, which polls every few seconds, leaves them off. `markRead=1` records the
  // highest message id in this list as the caller's read position (only forward).
  const includePolls = params.get('polls') === '1';
  const includeReactions = params.get('reactions') === '1';
  const includeDecisions = params.get('decisions') === '1';
  const includeReads = params.get('reads') === '1';
  const markRead = parseSwitch(params.get('markRead'));
  if (markRead === undefined) return error(400, '"markRead" must be 1 or 0.');
  const [messages, pinned, polls, reactions, decisions, reads] = await Promise.all([
    store.list({ since, to, limit, room }),
    store.pinned(room),
    includePolls ? store.listPolls() : Promise.resolve(null),
    includeReactions ? store.listReactions() : Promise.resolve(null),
    includeDecisions ? store.listDecisions() : Promise.resolve(null),
    includeReads ? store.listReads() : Promise.resolve(null),
  ]);
  if (markRead && messages.length) {
    try {
      await store.setReadPosition(me, messages[messages.length - 1].id);
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
    }
    if (includeReads) {
      // The list should include the position just recorded.
      const latest = await store.listReads();
      return json({
        me,
        messages,
        pinned,
        ...(includePolls ? { polls } : {}),
        ...(includeReactions ? { reactions } : {}),
        ...(includeDecisions ? { decisions } : {}),
        reads: latest,
      });
    }
  }
  return json({
    me,
    messages,
    pinned,
    ...(includePolls ? { polls } : {}),
    ...(includeReactions ? { reactions } : {}),
    ...(includeDecisions ? { decisions } : {}),
    ...(includeReads ? { reads } : {}),
  });
});

// POST /api/messages {"text": "...", "to": "<name>", "attachments": ["att_…"], "reply_to": 45}
// The sender is the owner of the Bearer token; any "sender"/"from" in the body is ignored.
// "attachments" is optional: up to 4 of the sender's own uploads that no message links yet.
// "reply_to" is optional: the id of an existing message that this one answers.
// "room" is optional: without it the message goes to `main`, or, as a reply, to the room of the
// message it answers.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parseMessageInput(body, loadRoster().names);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  let message;
  try {
    message = await store.add({ sender: me, recipient: input.recipient, text: input.text, pinned: input.pinned, attachments: input.attachments, reply_to: input.replyTo, room: input.room });
  } catch (e) {
    // Nothing was stored: the message and its links are one transaction.
    if (e instanceof AttachmentLinkError) return error(e.reason === 'already linked' ? 409 : e.reason === 'not yours' ? 403 : 404, e.message);
    if (e instanceof ReplyTargetError) return error(404, e.message);
    if (e instanceof RoomError) return roomError(e);
    throw e;
  }
  if (!message) {
    return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
  }
  // Wake the participant named grok, if the webhook is set up (lib/webhook.ts), in the background. The sender's response never waits for the webhook or fails because of it.
  const job = getWakeup(store)?.onMessage(message);
  if (job) waitUntil(job);
  return json({ message }, 201);
});
