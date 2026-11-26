'use client';

// Reactions on a message: a react button in the message's action row opens a short row
// (👍❤️👎😂🎉 plus more), pills for the current tally sit under the text, and a quiet hint
// is in the panel. The allow-list is the picker catalog. The panel is fixed, so it is not
// clipped by the stream, and it opens upward when there is no room above the message box.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REACTION_HINT, type Message, type Reaction, type Sender } from '../lib/core';
import { labelOf, type Participant } from '../lib/shared';
import type { MessageReactions } from '../lib/store';
import { EmojiPanel, RECENT_KEY, parseRecent, pushRecent } from './emoji';

export const QUICK_REACTIONS = ['👍', '❤️', '👎', '😂', '🎉'] as const;

export { REACTION_HINT };

/** Apply the complete current reaction list to a message list, clearing ones that are no longer present. */
export function applyReactionList(list: Message[], listed: MessageReactions[]): Message[] {
  const byId = new Map(listed.map((item) => [item.message_id, item.reactions]));
  return list.map((m) => ({ ...m, reactions: (byId.get(m.id) ?? []).map((r) => ({ emoji: r.emoji, by: [...r.by] })) }));
}

/** Replace existing items that appear in `incoming`; never append a new id. */
export function replaceMatching(list: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return list;
  const byId = new Map(incoming.map((m) => [m.id, m]));
  return list.map((m) => byId.get(m.id) ?? m);
}

/**
 * Where to put the reaction panel, in viewport coordinates. Opens below the button when there is
 * room above the message box (`reserveBottom` is the box's height); otherwise it opens upward.
 * The panel is then clamped so it stays on screen and its bottom edge stays above the message box.
 */
export function placeReactionPanel(
  anchor: { top: number; bottom: number; left: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  reserveBottom = 0,
  gap = 4,
): { top: number; left: number; placement: 'below' | 'above' } {
  const floor = viewport.height - Math.max(0, reserveBottom);
  const spaceBelow = floor - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap;
  const placement: 'below' | 'above' = spaceBelow >= panel.height || spaceBelow >= spaceAbove ? 'below' : 'above';
  let top = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - panel.height;
  const maxTop = floor - panel.height;
  // Prefer staying above the message box: if the panel is taller than the room above the box,
  // its top may go off-screen rather than cover the box.
  top = maxTop >= 0 ? Math.min(Math.max(0, top), maxTop) : maxTop;
  const left = Math.min(Math.max(0, anchor.left), Math.max(0, viewport.width - panel.width));
  return { top, left, placement };
}

function loadRecent(): string[] {
  try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; }
}
function saveRecent(recent: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* the picker works without it */ }
}

function labelFor(reaction: Reaction, me: Sender | null, participants: readonly Participant[]): string {
  const names = reaction.by.map((v) => (v === me ? 'you' : labelOf(v, participants)));
  const who = names.join(', ');
  return who ? `${reaction.emoji}, ${reaction.by.length}, ${who}` : `${reaction.emoji}, ${reaction.by.length}`;
}

interface BarProps {
  message: Message;
  me: Sender | null;
  /** From GET /api/participants, the same roster PollCard uses. Names are shown with their labels. */
  participants?: readonly Participant[];
  /** PUT or DELETE the emoji, then hand the updated message back. */
  onToggle: (emoji: string, on: boolean) => void;
  className?: string;
}

/** The pills under a message. The react button itself lives in the action row. */
export function ReactionBar({ message, me, onToggle, participants = [] }: BarProps) {
  const reactions = message.reactions ?? [];
  if (!reactions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((r) => {
        const mine = me !== null && r.by.includes(me);
        return (
          <button
            key={r.emoji}
            type="button"
            className={`cursor-pointer rounded-full border px-1.5 py-0.5 text-[13px] ${mine ? 'border-line bg-[#2a2f3a] text-fg' : 'border-line bg-transparent text-muted hover:bg-panel'}`}
            aria-pressed={mine}
            aria-label={labelFor(r, me, participants)}
            title={r.by.map((v) => labelOf(v, participants)).join(', ')}
            onClick={() => onToggle(r.emoji, !mine)}
          >
            {r.emoji} {r.by.length}
          </button>
        );
      })}
    </div>
  );
}

/** The react control in the message's action row: Reply, Quote, pin and react. */
export function ReactButton({ message, me, onToggle, className = '' }: BarProps) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'below' | 'above' } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const reactions = message.reactions ?? [];

  useEffect(() => {
    if (!open) { setMore(false); setPos(null); return undefined; }
    setRecent(loadRecent());
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (button.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = button.current;
      const box = panel.current;
      if (!anchor || !box) return;
      const footer = document.querySelector('footer');
      const reserveBottom = footer ? Math.max(0, window.innerHeight - footer.getBoundingClientRect().top) : 0;
      setPos(placeReactionPanel(
        anchor.getBoundingClientRect(),
        { width: box.offsetWidth, height: box.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        reserveBottom,
      ));
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, more]);

  const toggle = (emoji: string) => {
    if (!me) return;
    const mine = reactions.some((r) => r.emoji === emoji && r.by.includes(me));
    onToggle(emoji, !mine);
    if (!mine) {
      const next = pushRecent(loadRecent(), emoji);
      saveRecent(next);
      setRecent(next);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label="Add a reaction"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="React"
        onClick={() => setOpen((v) => !v)}
      >☺</button>
      {open && createPortal(
        <div
          ref={panel}
          id={panelId}
          // z-50 is above the message box (the footer stacks after the stream and would cover an
          // in-flow panel). fixed keeps the panel out of the stream's overflow.
          className="fixed z-50 rounded-md border border-line bg-[#1c1f28] p-2 shadow-lg"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
          data-placement={pos?.placement}
        >
          <div className="flex flex-wrap items-center gap-1">
            {QUICK_REACTIONS.map((emoji) => {
              const mine = me !== null && reactions.some((r) => r.emoji === emoji && r.by.includes(me));
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`cursor-pointer rounded-md border px-1.5 py-0.5 text-base ${mine ? 'border-line bg-[#2a2f3a]' : 'border-transparent hover:bg-panel'}`}
                  aria-pressed={mine}
                  aria-label={`React with ${emoji}`}
                  onClick={() => { toggle(emoji); setOpen(false); }}
                >{emoji}</button>
              );
            })}
            <button
              type="button"
              className="cursor-pointer rounded-md border border-transparent px-1.5 py-0.5 text-xs text-muted hover:border-line hover:text-fg"
              aria-expanded={more}
              onClick={() => setMore((v) => !v)}
            >more</button>
          </div>
          <p className="mt-1.5 max-w-[16rem] text-xs text-muted">{REACTION_HINT}</p>
          {more && (
            <div className="mt-2">
              <EmojiPanel
                recent={recent}
                onPick={(char) => { toggle(char); setOpen(false); }}
              />
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
