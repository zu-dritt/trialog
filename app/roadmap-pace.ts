// How eagerly the roadmap page follows the cards (Grok's review of PR 121): live while someone is
// there, and quiet enough otherwise that the database can scale to zero (it does after 5 idle minutes).
//   - Hidden tab: nothing at all. Back in view, it catches up at once.
//   - Visible, and someone moved, typed or scrolled, or a card changed, in the last REST_AFTER_MS: live.
//   - Visible but nobody there for REST_AFTER_MS: it rests, asking once every REST_POLL_MS (longer than
//     those 5 minutes). Any movement on the page, or a change it finds, makes it live again.

/** Quiet this long, and the page stops its live stream. */
export const REST_AFTER_MS = 10 * 60_000;
/** While resting: one look at the cards this often. Longer than the database's 5 idle minutes. */
export const REST_POLL_MS = 6 * 60_000;

export type Pace = 'off' | 'live' | 'rest';

/**
 * The hub's message pane rests the same way when nobody is at it (playground #1004), only later:
 * after 15 quiet minutes (no movement on the page, no new message). A hidden hub tab keeps its own
 * rule (it naps after 15 minutes hidden, app/nap.ts), so a chime still comes in a background tab.
 */
export const HUB_REST_AFTER_MS = 15 * 60_000;

/** Movements on the page that count as someone being there. */
export const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'] as const;

/** What the page should do now. `lastActive` is the last movement on the page or change of a card. */
export function paceFor(hidden: boolean, now: number, lastActive: number, restAfter: number = REST_AFTER_MS): Pace {
  if (hidden) return 'off';
  return now - lastActive >= restAfter ? 'rest' : 'live';
}

/** A short fingerprint of the cards as the page has them, to see whether a look while resting found a change. */
export function cardsKey(items: readonly { id: string; column: string; position: number; updated_at: string }[]): string {
  return items.map((i) => `${i.id}:${i.column}:${i.position}:${i.updated_at}`).sort().join(',');
}
