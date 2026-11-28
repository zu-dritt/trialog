// The watchdog (B of playground #1509): an agent someone asked for something, that has said nothing
// since. On 28 Nov an agent's listener stopped twice (#1191–#1201, #1507) and only the orchestrator
// noticed. Now the hub notices: after SILENT_AFTER_MIN the wait joins the orchestrator's
// «⛔ n for you» list. Read from the latest messages; nothing is stored.
import type { Message } from './core';
import type { Participant } from './shared';

/** How long an agent may stay quiet after being addressed before the orchestrator hears of it. */
export const SILENT_AFTER_MIN = 30;

export interface SilentAgent {
  agent: string;
  /** The oldest message to the agent that it hasn't answered with any message since. */
  message: Pick<Message, 'id' | 'room' | 'created_at'>;
  minutes: number;
}

/** A message asks the agent when it is addressed to it, or names it as @name. */
export function asks(message: Pick<Message, 'sender' | 'recipient' | 'text'>, agent: string): boolean {
  if (message.sender === agent || message.sender === 'hub') return false;
  if (message.recipient === agent) return true;
  return new RegExp(`(^|[^\\w@])@${agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message.text);
}

/**
 * Agents that were asked something more than SILENT_AFTER_MIN ago and have posted nothing since,
 * from `messages` (the latest few hundred, any room, any order). Any message of theirs counts as
 * awake, wherever it is: the point is whether they are there, not whether they answered that one.
 */
export function silentAgents(messages: readonly Pick<Message, 'id' | 'sender' | 'recipient' | 'text' | 'room' | 'created_at'>[], participants: readonly Participant[], now: number): SilentAgent[] {
  const sorted = [...messages].sort((a, b) => a.id - b.id);
  const out: SilentAgent[] = [];
  for (const p of participants) {
    if (p.kind !== 'agent') continue;
    const lastOwn = sorted.reduce((last, m) => (m.sender === p.name ? m.id : last), -1);
    const first = sorted.find((m) => m.id > lastOwn && asks(m, p.name));
    if (!first) continue;
    const minutes = Math.floor((now - Date.parse(first.created_at)) / 60_000);
    if (minutes >= SILENT_AFTER_MIN) out.push({ agent: p.name, message: { id: first.id, room: first.room, created_at: first.created_at }, minutes });
  }
  return out;
}
