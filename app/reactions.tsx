'use client';

// Reactions on a message: a smiley that opens a short row (👍❤️👎😂🎉 plus more),
// pills for the current tally, and a quiet hint. The allow-list is the picker catalog.
import { useEffect, useId, useRef, useState } from 'react';
import { REACTION_HINT, type Message, type Reaction, type Sender } from '../lib/core';
import { colorOf, displayName, type Participant } from '../lib/shared';
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

function loadRecent(): string[] {
  try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; }
}
function saveRecent(recent: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* the picker works without it */ }
}

function labelFor(reaction: Reaction, me: Sender | null): string {
  const names = reaction.by.map((v) => (v === me ? 'you' : displayName(v)));
  const who = names.join(', ');
  return who ? `${reaction.emoji}, ${reaction.by.length}, ${who}` : `${reaction.emoji}, ${reaction.by.length}`;
}

interface BarProps {
  message: Message;
  me: Sender | null;
  /** From GET /api/participants: gives a single reactor their colour. */
  participants?: readonly Participant[];
  /** PUT or DELETE the emoji, then hand the updated message back. */
  onToggle: (emoji: string, on: boolean) => void;
}

export function ReactionBar({ message, me, participants = [], onToggle }: BarProps) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const reactions = message.reactions ?? [];

  useEffect(() => {
    if (!open) { setMore(false); return undefined; }
    setRecent(loadRecent());
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
    <div ref={root} className="relative mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {reactions.map((r) => {
          const mine = me !== null && r.by.includes(me);
          return (
            <button
              key={r.emoji}
              type="button"
              className={`cursor-pointer rounded-full border px-1.5 py-0.5 text-[13px] ${mine ? 'border-line bg-[#2a2f3a] text-fg' : 'border-line bg-transparent text-muted hover:bg-panel'}`}
              aria-pressed={mine}
              aria-label={labelFor(r, me)}
              title={r.by.map((v) => displayName(v)).join(', ')}
              onClick={() => toggle(r.emoji)}
            >
              {r.emoji} <span style={r.by.length === 1 ? { color: colorOf(r.by[0], participants) } : undefined}>{r.by.length}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="cursor-pointer rounded-full border border-transparent px-1.5 py-0.5 text-[13px] text-muted opacity-40 hover:border-line hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          aria-label="Add a reaction"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
        >☺</button>
      </div>
      {open && (
        <div id={panelId} className="absolute z-20 mt-1 rounded-md border border-line bg-[#1c1f28] p-2 shadow-lg">
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
          <p className="mt-1.5 max-w-[16rem] text-[11px] text-muted">{REACTION_HINT}</p>
          {more && (
            <div className="mt-2">
              <EmojiPanel
                recent={recent}
                onPick={(char) => { toggle(char); setOpen(false); }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
