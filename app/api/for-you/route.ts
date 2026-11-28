import { forYou } from '../../../lib/for-you';
import { authenticate, json, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { MAIN_ROOM } from '../../../lib/shared';
import { getStore } from '../../../lib/store';
import { cachedMerges, streakBase } from '../../../lib/streak';
import { repoOf } from '../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/for-you → {items: [{kind, text, href, since}]}: what waits on the caller right now
// (lib/for-you.ts): decisions to answer, roadmap cards and agents' flights that wait on them. Built
// from the hub's own data, oldest first; nothing is stored. Merges (to settle cards) come from the
// streak's five-minute cache.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const repo = repoOf(process.env.TRIALOG_REPO);
  const [cards, roadmap, flights, merged] = await Promise.all([
    store.listDecisions(null),
    store.listRoadmap(),
    store.listFlights(),
    repo ? cachedMerges(repo, streakBase()) : Promise.resolve({ merges: [], problem: null }),
  ]);
  const messages = await store.listMessagesByIds(cards.map((c) => c.message_id));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const decisions = cards.map((decision) => ({ decision, recipient: byId.get(decision.message_id)?.recipient ?? null, room: byId.get(decision.message_id)?.room ?? MAIN_ROOM }));
  const items = forYou({ me, participants: loadRoster().participants, decisions, roadmap, flights, merged: new Set(merged.merges.map((m) => m.number)), repo, now: Date.now() });
  return json({ items });
});
