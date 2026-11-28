// Open decisions waiting on someone: the status-bar chip (playground #1186, #1188) and the
// server rule that an agent cannot Agree on a human-addressed decision.
import { decisionIsAgreed, type DecisionCard, type Participant, type Sender } from './shared';

/** A decision card together with the message it lives on, for the list and the chip. */
export interface DecisionListing {
  decision: DecisionCard;
  recipient: Sender | null;
  room: string;
}

/** Who may record a stance. The participant is always the token holder. When the card is addressed to a human, only that human may Agree or Object. */
export function canRecordDecisionPosition(
  participant: Sender,
  recipient: Sender | null,
  participants: readonly Participant[],
): boolean {
  if (!recipient) return true;
  const addressee = participants.find((p) => p.name === recipient);
  if (addressee?.kind === 'human') return participant === recipient;
  return true;
}

/**
 * When a decision is addressed to a human, it is agreed once that human has agreed (agents
 * cannot record a stance on their behalf, so "everyone" would never complete). Otherwise every
 * current participant must agree, as before.
 */
export function decisionShouldMarkAgreed(
  card: Pick<DecisionCard, 'positions'>,
  roster: readonly string[],
  recipient: Sender | null,
  participants: readonly Participant[],
): boolean {
  if (recipient && participants.some((p) => p.name === recipient && p.kind === 'human')) {
    return card.positions.some((p) => p.participant === recipient && p.stance === 'agree');
  }
  return decisionIsAgreed(card, roster);
}

/** Still waiting on `me`: not yet agreed, `me` has not answered, and it is addressed to them or to everyone. */
export function waitingOnMe(
  listing: Pick<DecisionListing, 'decision' | 'recipient'>,
  me: Sender,
): boolean {
  const { decision, recipient } = listing;
  if (decision.agreed_at) return false;
  if (decision.positions.some((p) => p.participant === me)) return false;
  return recipient === null || recipient === me;
}

export function openDecisionsFor(
  listings: readonly DecisionListing[],
  me: Sender,
): DecisionListing[] {
  return listings.filter((item) => waitingOnMe(item, me));
}

export function openDecisionChipLabel(count: number): string {
  return count === 1 ? '🗳 1 decision' : `🗳 ${count} decisions`;
}

/** The first line of a prompt, shortened for the chip's list. */
export function promptPreview(prompt: string, max = 80): string {
  const line = prompt.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}
