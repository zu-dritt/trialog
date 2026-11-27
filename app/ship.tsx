'use client';

// «🚀 Ship it!» on a message that links a pull request: one tap records the reader's go, shown as
// a chip («🚀 go from Orchestrator · HH:MM»); a second tap takes it back. It is a go signal only
// and does not merge or deploy anything. The chip says «shipped» only when that pull request is
// known to be merged. It is stored as a 🚀 reaction (the same table and API as the other
// reactions, so no schema change), and on these messages the 🚀 pill is shown as chips instead.
import { useEffect, useState } from 'react';
import type { Message, Sender } from '../lib/core';
import { shipChipText } from '../lib/build-it';
import { labelOf, type Participant } from '../lib/shared';
import { pullRequestNumbers } from './links';
import { loadPr, peekedPr } from './pr-card';

/** The reaction that stores a go. It is in the picker catalog, so the reactions API accepts it. */
export const SHIP_EMOJI = '🚀';

export const SHIP_HELP = "A go signal on this PR. It doesn't merge or deploy anything.";

export interface ShipGo { name: Sender; at?: string }

/** Who has given a go on this message, in the order they did, with when when the API sent it. */
export function shipGoesOf(message: Pick<Message, 'reactions'>): ShipGo[] {
  const r = message.reactions?.find((x) => x.emoji === SHIP_EMOJI);
  if (!r) return [];
  return r.by.map((name, i) => ({ name, at: r.at?.[i] }));
}

/** Who has shipped this message, in the order they did. */
export function shippersOf(message: Pick<Message, 'reactions'>): Sender[] {
  return shipGoesOf(message).map((g) => g.name);
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
  /** When already known: the pull request is merged (the chip then says «shipped»). */
  merged?: boolean;
}

/** The button and the chips, in the row with the reaction pills. */
export function ShipIt({ message, me, participants = [], onToggle, merged }: Props) {
  const goes = shipGoesOf(message);
  const mine = me !== null && goes.some((g) => g.name === me);
  const [knownMerged, setKnownMerged] = useState(merged === true);

  useEffect(() => {
    if (merged === true) { setKnownMerged(true); return; }
    if (merged === false) { setKnownMerged(false); return; }
    if (!goes.length) return;
    const n = pullRequestNumbers(message.text)[0];
    if (n == null) return;
    const peeked = peekedPr(n);
    if (peeked) { setKnownMerged(peeked.state === 'merged'); return; }
    void loadPr(n).then((s) => { if (s?.state === 'merged') setKnownMerged(true); });
  }, [merged, message.text, goes.length]);

  const isMerged = merged ?? knownMerged;
  return (
    <>
      <button
        type="button"
        data-ship=""
        className={`cursor-pointer rounded-full border px-2 py-0.5 text-[12px] ${mine ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line bg-transparent text-muted hover:bg-panel hover:text-fg'}`}
        aria-pressed={mine}
        aria-label={mine ? `Go recorded. Take it back. ${SHIP_HELP}` : `Ship it. ${SHIP_HELP}`}
        title={SHIP_HELP}
        disabled={!me}
        onClick={() => { const t = shipToggle(message, me); if (t) onToggle(t.emoji, t.on); }}
      >{SHIP_EMOJI} Ship it!</button>
      {goes.map((g) => (
        <span
          key={g.name}
          data-shipped={g.name}
          // Plain text, not a pill: it says who gave a go and is not something to click (playground #549).
          className={`px-0.5 text-[12px] ${g.name === me ? 'font-semibold text-fg' : 'text-muted'}`}
          title={SHIP_HELP}
        >{shipChipText(labelOf(g.name, participants), g.at, isMerged)}</span>
      ))}
    </>
  );
}
