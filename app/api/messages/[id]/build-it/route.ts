import { parseSince } from '../../../../../lib/core';
import { authenticate, error, json, safe } from '../../../../../lib/http';
import { loadRoster } from '../../../../../lib/participants';
import { buildItFromMessage, findBuiltCard } from '../../../../../lib/build-it';
import { getStore } from '../../../../../lib/store';
import { linksPullRequest, repoOf } from '../../../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const humansOf = () => loadRoster().participants.filter((p) => p.kind === 'human').map((p) => p.name);

// GET /api/messages/<id>/build-it → {item}: the card created from this message, if any.
export const GET = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const id = parseSince((await params).id);
  if (id === null || id === undefined) return error(400, 'Message id must be a whole number.');
  const store = await getStore();
  const [message] = await store.listMessagesByIds([id]);
  if (!message) return error(404, `No message #${id}.`);
  const item = findBuiltCard(await store.listRoadmap(), id);
  return item ? json({ item }) : error(404, `No Build-it card for message #${id}.`);
});

// POST /api/messages/<id>/build-it → a card at the top of Next (201), or the existing one (200).
// Only the orchestrator may create it. The message must be theirs and must not name a pull request.
// No hub message is posted, so nobody is woken. Idempotent.
export const POST = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const humans = humansOf();
  if (!humans.includes(me)) return error(403, 'Only the orchestrator can turn a message into a card.');
  const id = parseSince((await params).id);
  if (id === null || id === undefined) return error(400, 'Message id must be a whole number.');
  const store = await getStore();
  const [message] = await store.listMessagesByIds([id]);
  if (!message) return error(404, `No message #${id}.`);
  const result = await buildItFromMessage(store, {
    messageId: id,
    by: me,
    humans,
    namesPr: linksPullRequest(message.text, repoOf(process.env.TRIALOG_REPO)),
  });
  if (result.status === 'not_found') return error(404, `No message #${id}.`);
  if (result.status === 'not_from_orchestrator') return error(400, 'Build it is for messages from the orchestrator.');
  if (result.status === 'is_go') return error(400, 'This message is a go, not an idea: its card exists already.');
  if (result.status === 'names_pr') return error(400, 'This message names a pull request: use «🚀 Ship it!» instead.');
  if (result.status === 'full') return error(409, 'The roadmap is full (200 cards). Remove some done cards first.');
  return json({ item: result.item }, result.status === 'created' ? 201 : 200);
});
