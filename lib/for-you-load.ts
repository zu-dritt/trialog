// Gathers what «What waits on you» needs from the store and GitHub, for GET /api/for-you and the
// morning push (POST /api/for-you/notify). The list itself is built in lib/for-you.ts.
import { repoOf } from '../app/links';
import { forYou, type ForYouItem } from './for-you';
import { loadRoster } from './participants';
import { MAIN_ROOM } from './shared';
import type { Store } from './store';
import { cachedMerges, streakBase } from './streak';

export async function loadForYou(store: Store, me: string, now: number = Date.now()): Promise<ForYouItem[]> {
  const repo = repoOf(process.env.TRIALOG_REPO);
  const [cards, roadmap, flights, merged] = await Promise.all([
    store.listDecisions(null),
    store.listRoadmap(),
    store.listFlights(),
    // Merges settle cards and flights; they come from the streak's five-minute cache.
    repo ? cachedMerges(repo, streakBase()) : Promise.resolve({ merges: [], problem: null }),
  ]);
  const messages = await store.listMessagesByIds(cards.map((c) => c.message_id));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const decisions = cards.map((decision) => ({ decision, recipient: byId.get(decision.message_id)?.recipient ?? null, room: byId.get(decision.message_id)?.room ?? MAIN_ROOM }));
  return forYou({ me, participants: loadRoster().participants, decisions, roadmap, flights, merged: new Set(merged.merges.map((m) => m.number)), repo, now });
}
