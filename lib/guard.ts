// The loop and cost guard: it stops agents from waking each other in a runaway loop, and caps how
// much the agents write in a day. Nothing from Node is imported here, so the page can use it too.
//
// What counts: an "agent message" is a message whose sender is an `agent` on the roster
// (PARTICIPANTS). The hub's own messages never count, and neither do those of a name that is no
// longer on the roster. All agents and all rooms of the hub count together.
//
// Three limits, each from a setting with a default:
//   GUARD_PER_HOUR  agent messages in the last 60 minutes (rolling)            default 60
//   GUARD_IN_A_ROW  agent messages in a row, with no human message in between  default 12
//   GUARD_PER_DAY   agent messages in the last 24 hours (rolling)              default 300
//
// The guard is "tripped" when any limit is reached. While it is tripped, the hub sends no
// wake-up webhooks (lib/webhook.ts). Posting is never refused: the guard only stops agents
// from waking each other, and a human message lifts the pause:
//   - in a row: the count starts again at 0 with every human message;
//   - per hour and per day: "the moment the limit was reached" is the time of the Nth agent
//     message in the window (N being the limit). A human message after that moment lifts the
//     pause for the rest of that window. While the human is around, the in-a-row limit still
//     applies, so agents can't run on without them.
// When a message trips the guard, the hub posts one notice in that room, and once per 24 hours
// it posts a heads-up when the agents reach 80% of the daily limit.
//
// The guard keeps no state of its own: every answer is worked out from the messages of the last
// hours (Store.recentActivity), including the hub's own notices, which say whether a heads-up
// was already given and how many pauses there were.
import type { Participant } from './shared';

export interface GuardLimits {
  perHour: number;
  inARow: number;
  perDay: number;
}
export const GUARD_DEFAULTS: GuardLimits = { perHour: 60, inARow: 12, perDay: 300 };
/** At this share of the daily limit, the hub gives a heads-up. */
export const HEADS_UP_SHARE = 0.8;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** The chart shows this many hours, the current one last. */
export const CHART_HOURS = 24;
const MAX_LIMIT = 1_000_000;

/** A positive whole number from the setting, or the default. A value that can't be used is never read as "no limit". */
function positive(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value || !/^\d{1,7}$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= MAX_LIMIT ? n : fallback;
}

/** The limits of this hub: GUARD_PER_HOUR, GUARD_IN_A_ROW and GUARD_PER_DAY, each a positive whole number, else its default. */
export function guardLimits(env: Record<string, string | undefined> = process.env): GuardLimits {
  return {
    perHour: positive(env.GUARD_PER_HOUR, GUARD_DEFAULTS.perHour),
    inARow: positive(env.GUARD_IN_A_ROW, GUARD_DEFAULTS.inARow),
    perDay: positive(env.GUARD_PER_DAY, GUARD_DEFAULTS.perDay),
  };
}

/** The agent-message count at which the heads-up is given: 240 of 300. */
export const headsUpAt = (limits: GuardLimits): number => Math.max(1, Math.ceil(limits.perDay * HEADS_UP_SHARE));

/** One recent message, as much as the guard needs of it. */
export interface ActivityRow {
  id: number;
  sender: string;
  created_at: string;
  /** The start of the text, for the hub's own messages only (to find its earlier notices); null for everyone else. */
  head: string | null;
}

export type GuardLimit = 'hour' | 'in-a-row' | 'day';
export interface GuardCounts {
  /** Agent messages in the last 60 minutes. */
  hour: number;
  /** Agent messages since the last human message (within the last 24 hours). */
  inARow: number;
  /** Agent messages in the last 24 hours. */
  day: number;
}
export interface GuardState extends GuardCounts {
  /** The limit that holds wake-ups back, or null when they go out. */
  tripped: GuardLimit | null;
}

/** How far back the guard and the chart need messages: the start of the first hour on the chart, which is a bit more than 24 hours. */
export function activitySince(now: number): number {
  return startOfHour(now) - (CHART_HOURS - 1) * HOUR_MS;
}
const startOfHour = (t: number): number => Math.floor(t / HOUR_MS) * HOUR_MS;

/** The agents and the humans on the roster, by name. */
function kinds(roster: readonly Pick<Participant, 'name' | 'kind'>[]) {
  return {
    agents: new Set(roster.filter((p) => p.kind === 'agent').map((p) => p.name)),
    humans: new Set(roster.filter((p) => p.kind === 'human').map((p) => p.name)),
  };
}

/**
 * Whether a rolling-window limit holds wake-ups back: the window has at least `limit` agent
 * messages, and no human has written since the Nth of them (the moment the limit was reached).
 * `rows` are in id order and already inside the window.
 */
function windowHolds(rows: readonly ActivityRow[], agents: Set<string>, humans: Set<string>, limit: number): boolean {
  const fromAgents = rows.filter((r) => agents.has(r.sender));
  if (fromAgents.length < limit) return false;
  const reached = fromAgents[limit - 1].id;
  return !rows.some((r) => humans.has(r.sender) && r.id > reached);
}

/** The counts and whether the guard is tripped, `now` in milliseconds. */
export function guardState(rows: readonly ActivityRow[], roster: readonly Pick<Participant, 'name' | 'kind'>[], limits: GuardLimits, now: number): GuardState {
  const { agents, humans } = kinds(roster);
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const after = (since: number) => sorted.filter((r) => Date.parse(r.created_at) > since);
  const day = after(now - DAY_MS);
  const hour = after(now - HOUR_MS);
  let lastHuman = -1;
  day.forEach((r, i) => { if (humans.has(r.sender)) lastHuman = i; });
  const counts: GuardCounts = {
    hour: hour.filter((r) => agents.has(r.sender)).length,
    inARow: day.slice(lastHuman + 1).filter((r) => agents.has(r.sender)).length,
    day: day.filter((r) => agents.has(r.sender)).length,
  };
  // When more than one limit holds, the one named is the one a human can most easily act on.
  const tripped: GuardLimit | null = counts.inARow >= limits.inARow ? 'in-a-row'
    : windowHolds(hour, agents, humans, limits.perHour) ? 'hour'
    : windowHolds(day, agents, humans, limits.perDay) ? 'day'
    : null;
  return { ...counts, tripped };
}

// --- the hub's notices ------------------------------------------------------------------------

/** Every notice of the guard starts with this, so the guard can find its own earlier ones. */
export const NOTICE_PREFIX = 'Guard: ';
const PAUSE_PREFIX = `${NOTICE_PREFIX}wake-ups paused`;
const HEADS_UP_PREFIX = `${NOTICE_PREFIX}heads-up`;

/** What the hub says when a message trips the guard. */
export function pauseText(limit: GuardLimit, limits: GuardLimits): string {
  const why = limit === 'in-a-row' ? `${limits.inARow} agent messages in a row without a human`
    : limit === 'hour' ? `${limits.perHour} agent messages in the last hour`
    : `${limits.perDay} agent messages in the last 24 hours`;
  return `${PAUSE_PREFIX}, ${why}. Write anything to continue.`;
}

/** What the hub says at 80% of the daily limit. */
export function headsUpText(day: number, limits: GuardLimits): string {
  return `${HEADS_UP_PREFIX}: ${day} of ${limits.perDay} agent messages in the last 24 hours. Wake-ups pause at ${limits.perDay}; a message from a human lets them go on.`;
}

const hubSays = (rows: readonly ActivityRow[], prefix: string, since: number) =>
  rows.filter((r) => r.sender === 'hub' && r.head?.startsWith(prefix) && Date.parse(r.created_at) > since).length;

/** How many times the guard paused wake-ups in the last 24 hours: one hub notice each. */
export const pausesIn24h = (rows: readonly ActivityRow[], now: number): number => hubSays(rows, PAUSE_PREFIX, now - DAY_MS);
/** Whether the hub has given the heads-up in the last 24 hours. */
export const headsUpGiven = (rows: readonly ActivityRow[], now: number): boolean => hubSays(rows, HEADS_UP_PREFIX, now - DAY_MS) > 0;

export type GuardNotice = { kind: 'pause'; limit: GuardLimit; text: string } | { kind: 'heads-up'; text: string };

/**
 * The notice a new message calls for, or null. `before` is the guard without that message,
 * `after` with it. A pause notice when the message trips the guard (from not tripped to
 * tripped); otherwise a heads-up when it brings the day to 80% of the limit, unless one was
 * already given in the last 24 hours.
 */
export function noticeFor(before: GuardState, after: GuardState, limits: GuardLimits, warnedToday: boolean): GuardNotice | null {
  if (!before.tripped && after.tripped) return { kind: 'pause', limit: after.tripped, text: pauseText(after.tripped, limits) };
  if (after.tripped || warnedToday) return null;
  const at = headsUpAt(limits);
  if (before.day < at && after.day >= at) return { kind: 'heads-up', text: headsUpText(after.day, limits) };
  return null;
}

/** Who a notice is for: the human when there is exactly one, otherwise everyone (null). */
export function noticeRecipient(roster: readonly Pick<Participant, 'name' | 'kind'>[]): string | null {
  const humans = roster.filter((p) => p.kind === 'human');
  return humans.length === 1 ? humans[0].name : null;
}

// --- GET /api/guard ---------------------------------------------------------------------------

export interface GuardHour {
  /** The start of the hour, ISO 8601. */
  start: string;
  /** Agent messages in that hour, per agent on the roster (0 included). */
  bySender: Record<string, number>;
}
export interface GuardReport {
  limits: GuardLimits;
  now: GuardCounts;
  tripped: GuardLimit | null;
  /** The last 24 clock hours, oldest first; the last one is the current, unfinished hour. */
  hours: GuardHour[];
  /** How many times the guard paused wake-ups in the last 24 hours. */
  pausesToday: number;
}

/** Agent messages per clock hour for the chart, oldest first. */
export function hourBuckets(rows: readonly ActivityRow[], roster: readonly Pick<Participant, 'name' | 'kind'>[], now: number): GuardHour[] {
  const agents = roster.filter((p) => p.kind === 'agent').map((p) => p.name);
  const first = activitySince(now);
  const hours = Array.from({ length: CHART_HOURS }, (_, i) => ({
    start: new Date(first + i * HOUR_MS).toISOString(),
    bySender: Object.fromEntries(agents.map((name) => [name, 0])) as Record<string, number>,
  }));
  for (const r of rows) {
    if (!agents.includes(r.sender)) continue;
    const i = Math.floor((Date.parse(r.created_at) - first) / HOUR_MS);
    if (i >= 0 && i < CHART_HOURS) hours[i].bySender[r.sender] += 1;
  }
  return hours;
}

/** The answer of GET /api/guard. */
export function guardReport(rows: readonly ActivityRow[], roster: readonly Pick<Participant, 'name' | 'kind'>[], limits: GuardLimits, now: number): GuardReport {
  const { tripped, ...counts } = guardState(rows, roster, limits, now);
  return { limits, now: counts, tripped, hours: hourBuckets(rows, roster, now), pausesToday: pausesIn24h(rows, now) };
}
