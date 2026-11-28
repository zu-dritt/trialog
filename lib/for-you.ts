// «What waits on you» (roadmap card from playground #1462–#1464, after Will Larson's /my-open-work):
// one list of what only this person can move on, built from the hub's own data. Nothing is stored.
// - decisions addressed to them (or to everyone) that they haven't answered yet;
// - roadmap cards that wait on a human (the red LED), unless a merge has settled them;
// - an agent's flight that waits on them («waiting "David: merge PR 37"»).
// Each item says what to do and links to where it is done.
import { settledByMerge, waitingOn } from '../app/waits';
import { openDecisionsFor, promptPreview, type DecisionListing } from './open-decisions';
import { cardStatus, unblockHref, type RoadmapItem } from './roadmap';
import type { Flight, Participant } from './shared';

export interface ForYouItem {
  kind: 'decision' | 'card' | 'flight';
  /** What to do, in a line: «Agree or Object: …», «Card: …», «Grok waits: …». */
  text: string;
  /** Where to do it: the message in the hub, the card on the roadmap, or the address in the card's note. */
  href: string | null;
  /** When it started waiting, for the order (oldest first). */
  since: string;
  /** For a decision: the message to jump to in the hub, and its room. */
  message?: { id: number; room: string };
}

export function forYou(input: {
  me: string;
  participants: readonly Participant[];
  decisions: readonly DecisionListing[];
  roadmap: readonly RoadmapItem[];
  flights: readonly Flight[];
  merged: ReadonlySet<number>;
  repo: string | null;
  now: number;
}): ForYouItem[] {
  const { me, participants, decisions, roadmap, flights, merged, repo, now } = input;
  const person = participants.find((p) => p.name === me);
  // Only a human gives goes; an agent's list is the decisions addressed to it, nothing more.
  const human = person?.kind === 'human';
  const items: ForYouItem[] = [];
  for (const d of openDecisionsFor(decisions, me)) {
    items.push({ kind: 'decision', text: `Agree or Object: ${promptPreview(d.decision.prompt.replace(/^@\w+\s+/, ''), 90)}`, href: null, since: d.decision.created_at, message: { id: d.decision.message_id, room: d.room } });
  }
  if (human) {
    const humans = participants.filter((p) => p.kind === 'human').flatMap((p) => [p.name, p.label ?? '']).filter(Boolean);
    for (const card of roadmap) {
      const status = cardStatus(card, now, humans);
      if (status?.tone !== 'blocked' || settledByMerge(card.note, merged, repo)) continue;
      items.push({ kind: 'card', text: `Card: ${card.title}${card.note ? ` (${card.note})` : ''}`, href: unblockHref(card, status) ?? `/roadmap#${card.id}`, since: card.updated_at });
    }
    for (const w of waitingOn(flights, person, merged, repo)) {
      const label = participants.find((p) => p.name === w.by)?.label ?? w.by;
      items.push({ kind: 'flight', text: `${label} waits: ${w.text}`, href: null, since: w.since });
    }
  }
  return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}
