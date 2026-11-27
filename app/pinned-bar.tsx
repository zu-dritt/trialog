'use client';

// The bar at the top of a pane. It used to list every pinned message, and the list kept growing.
// Now only the decisions that still wait for agreement stand there, one line each. Everything
// else (decisions everyone has agreed, and the other pinned messages) folds into one small button
// at the right: «📌 3 pinned · ✓ 2 decided ▾». A click opens a short list of them; Escape or a press anywhere else closes it.
import { useEffect, useId, useRef, useState } from 'react';
import type { Message } from '../lib/core';
import { decisionIsAgreed, firstLine, type DecisionCard } from '../lib/shared';
import { DecisionBadge, isDecision } from './decision';

const dateFmt = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Whether a decision card counts as agreed. The server's mark (`agreed_at`) or everyone on the
 * roster agreeing is enough. The card in the stream uses the same test, so the two never disagree.
 */
export function cardIsAgreed(card: Pick<DecisionCard, 'agreed_at' | 'positions'>, roster: readonly string[]): boolean {
  return Boolean(card.agreed_at) || decisionIsAgreed(card, roster);
}

export interface PinnedSplit {
  /** Pinned messages with a decision card that is not agreed yet: these stand in the bar. */
  open: Message[];
  /** Pinned messages with an agreed decision card. */
  decided: Message[];
  /** Every other pinned message, a DECISION: line without a card among them. */
  pinned: Message[];
}

/** Sorts the pinned messages into the three groups of the bar. The order within a group is kept. */
export function splitPinned(list: readonly Message[], roster: readonly string[]): PinnedSplit {
  const split: PinnedSplit = { open: [], decided: [], pinned: [] };
  for (const m of list) {
    if (!m.decision) split.pinned.push(m);
    else if (cardIsAgreed(m.decision, roster)) split.decided.push(m);
    else split.open.push(m);
  }
  return split;
}

/** The fold button's words: «📌 3 pinned · ✓ 2 decided». A part with nothing in it is left out; null means no button. */
export function foldLabel(pinned: number, decided: number): string | null {
  const parts = [pinned > 0 ? `📌 ${pinned} pinned` : '', decided > 0 ? `✓ ${decided} decided` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** When a card was agreed, as «27.11., 21:04». Empty when the server has not stamped it. */
export function agreedWhen(card: Pick<DecisionCard, 'agreed_at'>): string {
  if (!card.agreed_at) return '';
  const date = new Date(card.agreed_at);
  return Number.isNaN(date.getTime()) ? '' : dateFmt.format(date);
}

interface Look {
  /** Participant names, for the DECISION: rule and the agreed test. */
  names: readonly string[];
  /** A participant's colour and shown name. */
  color: (name: string) => string;
  shown: (name: string) => string;
  /** Goes to a message in the stream, as the #id links do. */
  onJump: (id: number) => void;
}

const LINK = 'cursor-pointer text-fg no-underline hover:underline';

/** The folded list: «Decided» (prompt and when) and «Pinned» (author and first line). Each line goes to its message. */
export function FoldedList({ id, decided, pinned, names, color, shown, onJump }: Look & { id: string; decided: Message[]; pinned: Message[] }) {
  const jump = (e: { preventDefault: () => void }, messageId: number) => { e.preventDefault(); onJump(messageId); };
  return (
    <div id={id} className="mt-1 max-h-[40vh] overflow-auto border-t border-line/70 pb-1 pt-1.5 text-sm">
      {decided.length > 0 && (
        <>
          <h3 className="m-0 text-[11px] font-bold uppercase tracking-[.08em] text-decision">Decided</h3>
          <ul className="mb-1.5">
            {decided.map((m) => (
              <li key={m.id} className="truncate">
                <a href={`#m-${m.id}`} className={LINK} onClick={(e) => jump(e, m.id)}>{m.decision?.prompt || firstLine(m, 160)}</a>
                {m.decision && agreedWhen(m.decision) && <span className="text-xs text-muted"> · agreed {agreedWhen(m.decision)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {pinned.length > 0 && (
        <>
          <h3 className="m-0 text-[11px] font-bold uppercase tracking-[.08em] text-decision">Pinned</h3>
          <ul>
            {pinned.map((m) => (
              <li key={m.id} className="truncate">
                <a href={`#m-${m.id}`} className={LINK} onClick={(e) => jump(e, m.id)}>
                  <span className="font-bold" style={{ color: color(m.sender) }}>{shown(m.sender)}</span>{' '}
                  {isDecision(m.text, names, m.decision) && <><DecisionBadge />{' '}</>}
                  <span>{firstLine(m, 160)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The whole bar. Nothing at all when there is no open decision and nothing pinned. */
export function PinnedBar({ list, names, color, shown, onJump }: Look & { list: readonly Message[] }) {
  const { open, decided, pinned } = splitPinned(list, names);
  const label = foldLabel(pinned.length, decided.length);
  const [unfolded, setUnfolded] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const showList = unfolded && Boolean(label);

  useEffect(() => {
    if (!showList) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = rootRef.current?.contains(document.activeElement);
      setUnfolded(false);
      if (inside) buttonRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node | null)) setUnfolded(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [showList]);

  if (!open.length && !label) return null;
  const jumpAndFold = (id: number) => { setUnfolded(false); onJump(id); };

  return (
    <section ref={rootRef} aria-label="Decisions and pinned" className={`border-b border-line bg-[#1a1712] px-4 ${open.length ? 'py-2' : 'py-1'}`}>
      <div className="flex items-start gap-2">
        {open.length > 0 && (
          <ul className="max-h-[25vh] min-w-0 flex-1 overflow-auto text-sm" aria-label="Decisions waiting for agreement">
            {open.map((m) => (
              <li key={m.id} className="truncate">
                <DecisionBadge />{' '}
                <a href={`#m-${m.id}`} className={LINK} onClick={(e) => { e.preventDefault(); onJump(m.id); }}>{m.decision!.prompt}</a>
              </li>
            ))}
          </ul>
        )}
        {label && (
          <button
            ref={buttonRef} type="button"
            className="ml-auto flex-none cursor-pointer whitespace-nowrap rounded-md border border-line bg-transparent px-2 py-0.5 text-xs text-muted hover:text-fg"
            aria-expanded={showList} aria-controls={showList ? listId : undefined}
            onClick={() => setUnfolded((v) => !v)}
          >{label} {showList ? '▴' : '▾'}</button>
        )}
      </div>
      {showList && <FoldedList id={listId} decided={decided} pinned={pinned} names={names} color={color} shown={shown} onJump={jumpAndFold} />}
    </section>
  );
}
