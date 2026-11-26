import { MAX_BODY_BYTES, parsePinInput, parseSince } from '../../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../../lib/http';
import { getStore } from '../../../../../lib/store';
import { getWakeup } from '../../../../../lib/webhook';
import { waitUntil } from '@vercel/functions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Room for a pin-title wake-up job after the response: 2 s debounce plus two attempts of up to 5 s.
export const maxDuration = 60;

// POST /api/messages/<id>/pin {"pinned": true|false, "title"?}  (any participant may pin)
// {"title": "..."} alone changes the title of a message that is already pinned.
export const POST = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const id = parseSince((await params).id);
  if (id === null || id === undefined) return error(400, 'Message id must be a whole number.');
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parsePinInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  const result = input.pinned === undefined
    ? await store.setPinTitle(id, input.title as string)
    : await store.setPinned(id, input.pinned, input.title);
  if (result === 'not-pinned') return error(400, 'A title can only be set on a pinned message.');
  if (!result) return error(404, `No message #${id}.`);
  const message = result;
  // When a message is pinned without a title, wake an agent to write one (whoToWake on the
  // pinner, as if they had written to everyone). A title passed in the same request is enough.
  if (message.pinned_at && !message.pin_title) {
    const job = getWakeup(store).onPinTitle(message, me);
    if (job) waitUntil(job);
  }
  // The pinned list of the room the message is in, which is the list the caller is looking at.
  return json({ message, pinned: await store.pinned(message.room) });
});
