// The Pinned bar: a short title for each pin, with ✎ to edit it. The start of the text is
// used only until a title is set.

'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Message } from '../lib/core';
import { PIN_TITLE_MAX_LENGTH, colorOf, firstLine, labelOf, type Participant } from '../lib/shared';
import { DecisionBadge, isDecision, pinnedListTitle } from './decision';

export function PinnedBar({
  pinned,
  names,
  participants,
  onJump,
  onSaveTitle,
}: {
  pinned: Message[];
  names: readonly string[];
  participants: readonly Participant[];
  onJump: (id: number) => void;
  onSaveTitle: (m: Message, title: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (e: MouseEvent, m: Message) => {
    e.preventDefault();
    e.stopPropagation();
    setEditing(m.id);
    setDraft(m.pin_title ?? '');
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const cancel = () => {
    if (saving) return;
    setEditing(null);
    setDraft('');
  };

  const save = async (m: Message) => {
    const title = draft.replace(/[\r\n\t]+/g, ' ').trim();
    if (!title || title === (m.pin_title ?? '')) {
      cancel();
      return;
    }
    if ([...title].length > PIN_TITLE_MAX_LENGTH) return;
    setSaving(true);
    try {
      await onSaveTitle(m, title);
      setEditing(null);
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = (e: FormEvent, m: Message) => {
    e.preventDefault();
    void save(m);
  };

  const onKey = (e: KeyboardEvent, m: Message) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <section className="max-h-[25vh] overflow-auto border-b border-line bg-[#1a1712] px-4 py-2">
      <h2 className="mb-1 text-xs font-bold uppercase tracking-[.08em] text-decision">{pinnedListTitle(pinned, names)}</h2>
      <ul className="text-sm">
        {pinned.map((m) => {
          const shown = labelOf(m.sender, participants);
          const color = colorOf(m.sender, participants);
          const isEditing = editing === m.id;
          return (
            <li key={m.id} className="flex items-baseline gap-2 py-0.5">
              {isEditing ? (
                <form className="flex min-w-0 flex-1 items-baseline gap-2" onSubmit={(e) => onSubmit(e, m)}>
                  <input
                    ref={inputRef}
                    className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-0.5 text-sm font-semibold text-fg outline-none focus:border-accent"
                    value={draft}
                    maxLength={PIN_TITLE_MAX_LENGTH}
                    disabled={saving}
                    aria-label={`Title for #${m.id}`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => onKey(e, m)}
                    onBlur={() => { void save(m); }}
                  />
                </form>
              ) : (
                <a
                  href={`#m-${m.id}`}
                  className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap no-underline hover:underline"
                  onClick={(e) => { e.preventDefault(); onJump(m.id); }}
                >
                  {m.pin_title ? (
                    <span className="font-semibold text-fg">{m.pin_title}</span>
                  ) : (
                    <span className="text-muted">{firstLine(m, 160) || 'Title pending'}</span>
                  )}
                </a>
              )}
              <span className="flex shrink-0 items-baseline gap-1 text-xs text-muted">
                <a href={`#m-${m.id}`} className="no-underline hover:underline" onClick={(e) => { e.preventDefault(); onJump(m.id); }}>#{m.id}</a>
                <span aria-hidden="true">·</span>
                <span className="font-bold" style={{ color }}>{shown}</span>
                {isDecision(m.text, names, m.decision) && <DecisionBadge />}
                <button
                  type="button"
                  className="cursor-pointer rounded border-none bg-transparent px-1 text-[13px] text-muted hover:text-fg"
                  title="Edit title"
                  aria-label={`Edit title of #${m.id}`}
                  onClick={(e) => startEdit(e, m)}
                >
                  ✎
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
