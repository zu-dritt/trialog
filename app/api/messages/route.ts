import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parseLimit, parseMessageInput, parseRecipient, parseSince } from '../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { SEARCH_LIMIT, parseQuery } from '../../../lib/search';
import { waitUntil } from '@vercel/functions';
import { AttachmentLinkError, ReplyTargetError, getStore } from '../../../lib/store';
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

// GET /api/messages?since=<id>&to=<name>&limit=<n>
// Without `since`: the latest messages. With `since`: messages with a higher id, oldest first.
// Always includes the pinned decisions and who you are (derived from your token).
//
// GET /api/messages?q=<words>&to=<name>&decisions=1&pinned=1&limit=<n>
// Search: the messages that contain every word, newest first, as {me, messages}.
// decisions=1: only messages that start with DECISION: (pinned or not). pinned=1: only pinned ones.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const since = parseSince(params.get('since'));
  if (since === undefined) return error(400, '"since" must be a message id (a whole number).');
  const to = parseRecipient(params.get('to'));
  if (to === undefined) return error(400, '"to" must be grok, claude or david.');
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
    return json({ me, messages: await store.search({ words: query.words, to, decisions, pinned, limit }) });
  }
  // The top-level polls list is opt-in (`?polls=1`). The page asks for it so a since-poll
  // still sees votes on older polls; the CLI, which polls every few seconds, leaves it off.
  const includePolls = params.get('polls') === '1';
  const [messages, pinned, polls] = await Promise.all([
    store.list({ since, to, limit }),
    store.pinned(),
    includePolls ? store.listPolls() : Promise.resolve(null),
  ]);
  return json(includePolls ? { me, messages, pinned, polls } : { me, messages, pinned });
});

// POST /api/messages {"text": "...", "to": "claude", "attachments": ["att_…"], "reply_to": 45}
// The sender is the owner of the Bearer token; any "sender"/"from" in the body is ignored.
// "attachments" is optional: up to 4 of the sender's own uploads that no message links yet.
// "reply_to" is optional: the id of an existing message that this one answers.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parseMessageInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  let message;
  try {
    message = await store.add({ sender: me, recipient: input.recipient, text: input.text, pinned: input.pinned, attachments: input.attachments, reply_to: input.replyTo });
  } catch (e) {
    // Nothing was stored: the message and its links are one transaction.
    if (e instanceof AttachmentLinkError) return error(e.reason === 'already linked' ? 409 : e.reason === 'not yours' ? 403 : 404, e.message);
    if (e instanceof ReplyTargetError) return error(404, e.message);
    throw e;
  }
  if (!message) {
    return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} messages per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
  }
  // Wake Grok in the background. The sender's response never waits for the webhook or fails because of it.
  const job = getWakeup(store)?.onMessage(message);
  if (job) waitUntil(job);
  return json({ message }, 201);
});
