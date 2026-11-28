// The server side of the loop and cost guard (the rules are in lib/guard.ts): what the guard says
// right now, and the hub's notice after a message that trips it or nears the daily limit.
import type { Message } from './core';
import { activitySince, guardLimits, guardState, headsUpGiven, noticeFor, noticeRecipient, type GuardLimits, type GuardState } from './guard';
import { loadRoster } from './participants';
import type { Participant } from './shared';
import type { Store } from './store';

export interface GuardContext {
  /** Left out: the PARTICIPANTS setting. */
  roster?: readonly Participant[];
  /** Left out: the GUARD_* settings. */
  limits?: GuardLimits;
  /** Milliseconds. Left out: now. */
  now?: number;
}

const resolve = (ctx: GuardContext) => ({
  roster: ctx.roster ?? loadRoster().participants,
  limits: ctx.limits ?? guardLimits(),
  now: ctx.now ?? Date.now(),
});

/** The guard as it stands now: the counts and the limit that holds wake-ups back, if any. */
export async function currentGuard(store: Store, ctx: GuardContext = {}): Promise<GuardState> {
  const { roster, limits, now } = resolve(ctx);
  return guardState(await store.recentActivity(activitySince(now)), roster, limits, now);
}

/**
 * Call after a message has been stored. When that message trips the guard, or brings the day to
 * 80% of its limit, the hub posts one notice in the same room, to the human when there is one
 * (lib/guard.ts says when exactly). Returns the notice, or null. Never throws: the message is
 * already stored, and its sender must not get an error because of the guard.
 *
 * Before and after are worked out from the same rows, cut at this message's id, so two messages
 * that arrive at once can't both claim to be the one that crossed the line.
 */
export async function postGuardNotice(store: Store, message: Pick<Message, 'id' | 'sender' | 'room'>, ctx: GuardContext = {}): Promise<Message | null> {
  try {
    const { roster, limits, now } = resolve(ctx);
    // Only an agent message can trip the guard or bring the day nearer its limit.
    if (!roster.some((p) => p.name === message.sender && p.kind === 'agent')) return null;
    const rows = await store.recentActivity(activitySince(now));
    const before = guardState(rows.filter((r) => r.id < message.id), roster, limits, now);
    const after = guardState(rows.filter((r) => r.id <= message.id), roster, limits, now);
    const notice = noticeFor(before, after, limits, headsUpGiven(rows, now));
    if (!notice) return null;
    return await store.add({ sender: 'hub', recipient: noticeRecipient(roster), text: notice.text, room: message.room });
  } catch (e) {
    console.error('[trialog] guard notice failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
