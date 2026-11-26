import { MAX_BODY_BYTES, RATE_LIMIT_PER_MIN, parseLimit, parseMessageInput, parseRecipient, parseSince, recipientHint } from '../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { waitUntil } from '@vercel/functions';
import { loadRoster } from '../../../lib/participants';
import { AttachmentLinkError, ReplyTargetError, getStore } from '../../../lib/store';
import { getWakeup } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Room for the wake-up webhook job after the response: 2 s debounce plus three attempts of up to 5 s.
export const maxDuration = 60;

// GET /api/messages?since=<id>&to=<name>&limit=<n>
// Without `since`: the latest messages. With `since`: messages with a higher id, oldest first.
// Always includes the pinned decisions and who you are (derived from your token).
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const since = parseSince(params.get('since'));
  if (since === undefined) return error(400, '"since" must be a message id (a whole number).');
  const { names } = loadRoster();
  const to = parseRecipient(params.get('to'), names);
  if (to === undefined) return error(400, recipientHint(names));
  const limit = parseLimit(params.get('limit'));
  if (limit === undefined) return error(400, '"limit" must be a whole number.');
  const store = await getStore();
  const [messages, pinned, polls] = await Promise.all([store.list({ since, to, limit }), store.pinned(), store.listPolls()]);
  return json({ me, messages, pinned, polls });
});

// POST /api/messages {"text": "...", "to": "<name>", "attachments": ["att_…"], "reply_to": 45}
// The sender is the owner of the Bearer token; any "sender"/"from" in the body is ignored.
// "attachments" is optional: up to 4 of the sender's own uploads that no message links yet.
// "reply_to" is optional: the id of an existing message that this one answers.
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
  // Wake the participant named grok, if the webhook is set up (lib/webhook.ts), in the background. The sender's response never waits for the webhook or fails because of it.
  const job = getWakeup(store)?.onMessage(message);
  if (job) waitUntil(job);
  return json({ message }, 201);
});
