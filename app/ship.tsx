'use client';

// «🚀 Ship it!» on a message that links a pull request: one tap records the reader's go, shown as
// a chip («🚀 David shipped it»); a second tap takes it back. It is a go signal only and does not
// merge or deploy anything. It is stored as a 🚀 reaction (the same table and API as the other
// reactions, so no schema change), and on these messages the 🚀 pill is shown as chips instead.
import type { Message, Sender } from '../lib/core';
import { labelOf, type Participant } from '../lib/shared';

/** The reaction that stores a go. It is in the picker catalog, so the reactions API accepts it. */
export const SHIP_EMOJI = '🚀';

export const SHIP_HELP = "A go signal on this PR. It doesn't merge or deploy anything.";

/** Who has shipped this message, in the order they did. */
export function shippersOf(message: Pick<Message, 'reactions'>): Sender[] {
  return [...(message.reactions?.find((r) => r.emoji === SHIP_EMOJI)?.by ?? [])];
}

/** What a tap does: ship when the reader hasn't yet, take it back when they have. Null without a token. */
export function shipToggle(message: Pick<Message, 'reactions'>, me: Sender | null): { emoji: string; on: boolean } | null {
  if (!me) return null;
  return { emoji: SHIP_EMOJI, on: !shippersOf(message).includes(me) };
}

interface Props {
  message: Message;
  me: Sender | null;
  participants?: readonly Participant[];
  onToggle: (emoji: string, on: boolean) => void;
}

/** The button and the chips, in the row with the reaction pills. */
export function ShipIt({ message, me, participants = [], onToggle }: Props) {
  const shippers = shippersOf(message);
  const mine = me !== null && shippers.includes(me);
  return (
    <>
      <button
        type="button"
        data-ship=""
        className={`cursor-pointer rounded-full border px-2 py-0.5 text-[12px] ${mine ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line bg-transparent text-muted hover:bg-panel hover:text-fg'}`}
        aria-pressed={mine}
        aria-label={mine ? `Shipped. Take back your go. ${SHIP_HELP}` : `Ship it. ${SHIP_HELP}`}
        title={SHIP_HELP}
        disabled={!me}
        onClick={() => { const t = shipToggle(message, me); if (t) onToggle(t.emoji, t.on); }}
      >{SHIP_EMOJI} Ship it!</button>
      {shippers.map((name) => (
        <span
          key={name}
          data-shipped={name}
          // Plain text, not a pill: it says who gave a go and is not something to click (playground #549).
          className={`px-0.5 text-[12px] ${name === me ? 'font-semibold text-fg' : 'text-muted'}`}
          title={SHIP_HELP}
        >{SHIP_EMOJI} {labelOf(name, participants)} shipped it</span>
      ))}
    </>
  );
}
