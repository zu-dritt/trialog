'use client';

// A one-line summary, for a human, of who has a wake-up target. Host only, never a secret or a URL.
import { labelOf, type Participant } from '../lib/shared';

export type ParticipantWithWake = Participant & {
  wake_target_host?: string | null;
  wake_target_set_at?: string | null;
};

export function WakeTargetsLine({ me, participants }: { me: string | null; participants: readonly ParticipantWithWake[] }) {
  const self = participants.find((p) => p.name === me);
  if (self?.kind !== 'human') return null;
  if (!participants.some((p) => 'wake_target_host' in p)) return null;
  const set = participants.filter((p) => p.wake_target_host);
  const text = set.length
    ? set.map((p) => `${labelOf(p.name, participants)} (${p.wake_target_host})`).join(' · ')
    : 'none set';
  return (
    <p className="mb-0 border-b border-line px-4 py-1 text-xs text-muted" aria-label="Wake-up targets">
      Wake-ups: {text}
    </p>
  );
}
