// The health chips (app/health.tsx), the server side: for each agent, how long ago the hub last heard
// from it, what it is doing, whether it waits on a human, and its last merged pull request.
//
// Nothing here is a self-report, and nothing is new in the database. The heartbeat comes from three
// things the hub already keeps: the agent's last message, its status and its flight. A watcher that
// hangs stops all three, so its heartbeat turns grey by itself, even while its flight still says «working».
import { flightSteps, settledByMerge } from '../app/waits';
import type { Merge } from './streak';
import type { Flight, FlightState, Participant, ParticipantStatus } from './shared';

/** Green below this many minutes without a word, amber from here, grey from HEARTBEAT_GREY_MINUTES. */
export const HEARTBEAT_AMBER_MINUTES = 10;
export const HEARTBEAT_GREY_MINUTES = 20;
const MINUTE = 60_000;

export type Heartbeat = 'green' | 'amber' | 'grey';
/** One word for what the agent is doing. «reviewing» is a flight in progress whose text says review. */
export type HealthWord = 'building' | 'reviewing' | 'waiting' | 'resting';

/** The heartbeat for an age in milliseconds. A clock a little ahead counts as «just now»; nobody heard from is grey. */
export function heartbeatOf(ageMs: number | null): Heartbeat {
  if (ageMs === null || !Number.isFinite(ageMs)) return 'grey';
  const minutes = Math.max(0, ageMs) / MINUTE;
  if (minutes >= HEARTBEAT_GREY_MINUTES) return 'grey';
  return minutes >= HEARTBEAT_AMBER_MINUTES ? 'amber' : 'green';
}

/** The newest of the agent's last message, status and flight, as an ISO time, or null when there is none. */
export function lastHeard(parts: { flight?: Pick<Flight, 'updated_at' | 'last_message_at'> | null; status?: Pick<ParticipantStatus, 'updated_at'> | null }): string | null {
  const times = [parts.flight?.updated_at, parts.flight?.last_message_at, parts.status?.updated_at]
    .map((at) => (at ? Date.parse(at) : Number.NaN)).filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** building · reviewing · waiting · resting. No flight at all is resting. */
export function wordOf(flight: Pick<Flight, 'state' | 'text'> | null | undefined): HealthWord {
  const state: FlightState = flight?.state ?? 'idle';
  if (state === 'idle') return 'resting';
  if (state === 'waiting') return 'waiting';
  return /\breview/i.test(flight?.text ?? '') ? 'reviewing' : 'building';
}

/** The emoji each agent chose for its chip. Another agent gets a neutral one until it picks its own. */
export const HEALTH_EMOJI: Readonly<Record<string, string>> = { grok: '🔥', claude: '🛠️' };
export const DEFAULT_HEALTH_EMOJI = '🙂';

export interface HealthBlocked { on: string; text: string; since: string }
export interface AgentHealth {
  participant: string;
  emoji: string;
  /** When the hub last heard from the agent (message, status or flight), or null. */
  heard_at: string | null;
  /** How long ago that was, by the hub's clock, so a browser with a wrong clock still shows the right colour. */
  heard_ago_ms: number | null;
  heartbeat: Heartbeat;
  word: HealthWord;
  state: FlightState;
  /** The flight's text, empty while resting. */
  text: string;
  /** Set while a «waiting» flight has a step for a human: who, what, since when. */
  blocked: HealthBlocked | null;
  /** The agent's own last pull request that was merged (its branch starts «name/»). */
  last_merge: { pr: number; merged_at: string } | null;
}
export interface HealthReport { now: string; agents: AgentHealth[] }

/** The wait on a human that a flight carries, unless a merge has settled it (the rule of the flight strip). */
export function blockedOf(flight: Flight | null | undefined, humans: readonly Pick<Participant, 'name' | 'label'>[], merged: ReadonlySet<number>, repo: string | null): HealthBlocked | null {
  if (!flight || flight.state !== 'waiting') return null;
  for (const step of flightSteps(flight.text)) {
    if (step.name === null) continue;
    const who = humans.find((h) => [h.name, h.label].some((n) => n && n.toLowerCase() === step.name!.toLowerCase()));
    if (who && !settledByMerge(step.text, merged, repo)) return { on: who.label || who.name, text: step.text, since: flight.since };
  }
  return null;
}

/** The newest merge of a pull request on the agent's own branch («claude/…»). */
export function lastMergeOf(name: string, merges: readonly Merge[]): { pr: number; merged_at: string } | null {
  let best: Merge | null = null;
  for (const m of merges) {
    if (!m.branch?.startsWith(`${name}/`)) continue;
    if (!best || Date.parse(m.merged_at) > Date.parse(best.merged_at)) best = m;
  }
  return best && { pr: best.number, merged_at: best.merged_at };
}

export function healthReport(input: {
  roster: readonly Participant[];
  flights: readonly Flight[];
  statuses: readonly ParticipantStatus[];
  merges: readonly Merge[];
  repo: string | null;
  now: number;
}): HealthReport {
  const { roster, flights, statuses, merges, repo, now } = input;
  const humans = roster.filter((p) => p.kind === 'human');
  const mergedNumbers = new Set(merges.map((m) => m.number));
  const agents = roster.filter((p) => p.kind === 'agent').map((p): AgentHealth => {
    const flight = flights.find((f) => f.participant === p.name) ?? null;
    const status = statuses.find((s) => s.participant === p.name && Date.parse(s.expires_at) > now) ?? null;
    const heard = lastHeard({ flight, status });
    const ago = heard === null ? null : Math.max(0, now - Date.parse(heard));
    return {
      participant: p.name,
      emoji: HEALTH_EMOJI[p.name] ?? DEFAULT_HEALTH_EMOJI,
      heard_at: heard,
      heard_ago_ms: ago,
      heartbeat: heartbeatOf(ago),
      word: wordOf(flight),
      state: flight?.state ?? 'idle',
      text: flight && flight.state !== 'idle' ? flight.text : '',
      blocked: blockedOf(flight, humans, mergedNumbers, repo),
      last_merge: lastMergeOf(p.name, merges),
    };
  });
  return { now: new Date(now).toISOString(), agents };
}
