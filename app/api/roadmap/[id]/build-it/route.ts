import { waitUntil } from '@vercel/functions';
import { buildText } from '../../../../../lib/build-it';
import { postGuardNotice } from '../../../../../lib/guard-hub';
import { authenticate, error, json, safe } from '../../../../../lib/http';
import { loadRoster } from '../../../../../lib/participants';
import { notifyPushForMessage, schedulePush } from '../../../../../lib/push';
import { ROADMAP_ID } from '../../../../../lib/roadmap';
import { getStore } from '../../../../../lib/store';
import { getWakeup } from '../../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// POST /api/roadmap/<id>/build-it → {item, message}: the orchestrator's «🚀 Build it!» on a card in
// Next or Later (playground #1185, #1219). In one locked step the card goes to the top of Now; then
// the go is posted as the orchestrator's message (to the card's owner, or to everyone), which wakes
// the agents like any message of theirs. Only a human may give it (403 for an agent). A card that is
// no longer in Next or Later answers 409 and posts nothing, so a second call can't post a second go.
export const POST = safe(async (request: Request, ctx: Ctx) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  if (loadRoster().participants.find((p) => p.name === me)?.kind !== 'human') {
    return error(403, 'Only the orchestrator gives the go to build a card.');
  }
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  const store = await getStore();
  const started = await store.startRoadmapItem(id, me);
  if (started.status === 'not_found') return error(404, 'No such card.');
  if (started.status === 'started') return json({ error: 'This card is already under way (not in Next or Later). No second go was posted.', item: started.item }, 409);
  const card = started.item;
  const message = await store.add({ sender: me, recipient: card.owner, text: buildText(card), pinned: false, attachments: [], reply_to: null, room: 'main' });
  if (!message) {
    // Rate limit: nothing was said, so the card goes back to where it was, and the go can be given again.
    await store.updateRoadmapItem(id, { column: started.from }, me);
    return error(429, 'Rate limit: too many messages this minute. Nothing changed; try again in a moment.', { 'Retry-After': '60' });
  }
  await postGuardNotice(store, message);
  const job = getWakeup(store).onMessage(message);
  if (job) waitUntil(job);
  schedulePush(notifyPushForMessage(store, message));
  return json({ item: card, message }, 201);
});
