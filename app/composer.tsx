'use client';

// The message box: how tall it is, keeping an unsent draft across a reload, and the row of
// actions under it (ComposerTools, at the end).
//
// The box grows with its text, line by line, up to a share of the window, and scrolls after
// that. A button switches it to a tall writing area and back. The text of an unsent message is
// kept in this browser per participant, so a reload doesn't lose it. Only the text: no images,
// and nothing leaves the browser.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { EmojiPicker } from './emoji';
import { parseQuotes, type Quote } from './quote';

/** The box grows with its text up to this share of the visible window, then scrolls. */
export const GROW_SHARE = 0.4;
/** The height of the tall writing area, as a share of the visible window. */
export const EXPANDED_SHARE = 0.6;
/** Never smaller than this, however small the window is: about two lines. */
export const MIN_BOX_HEIGHT = 60;

export interface BoxSize {
  /** Height of the box in pixels. */
  height: number;
  /** Whether the text is taller than the box, so the box needs its scroll bar. */
  scrolls: boolean;
}

/**
 * How tall the message box should be.
 *   contentHeight   what the text needs, borders included
 *   viewportHeight  the visible window; on a phone, what the on-screen keyboard leaves
 *   expanded        the tall writing area is switched on
 */
export function boxSize(contentHeight: number, viewportHeight: number, expanded: boolean, minHeight: number = MIN_BOX_HEIGHT): BoxSize {
  const share = Math.round(viewportHeight * (expanded ? EXPANDED_SHARE : GROW_SHARE));
  const limit = Math.max(minHeight, share);
  // Expanded: always the tall size. Otherwise: as tall as the text, between the two limits.
  const height = expanded ? limit : Math.min(limit, Math.max(minHeight, Math.ceil(contentHeight)));
  return { height, scrolls: contentHeight > height + 1 };
}

/**
 * The height of what is visible of the page. On a phone with the on-screen keyboard open this is
 * the part above the keyboard, which is what the box has to fit into. 0 until it is known.
 */
export function useViewportHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const read = () => setHeight(Math.round(window.visualViewport?.height ?? window.innerHeight));
    read();
    window.addEventListener('resize', read);
    window.visualViewport?.addEventListener('resize', read);
    return () => {
      window.removeEventListener('resize', read);
      window.visualViewport?.removeEventListener('resize', read);
    };
  }, []);
  return height;
}

/** Keeps the height of the message box in step with its text, the window and the expand button. */
export function useBoxHeight(boxRef: RefObject<HTMLTextAreaElement | null>, text: string, expanded: boolean, viewportHeight: number): void {
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !viewportHeight) return;
    // Let the box take the height of its text for a moment, to measure it. scrollHeight leaves
    // the border out; the difference between the two outer measures puts it back.
    box.style.height = 'auto';
    const content = box.scrollHeight + (box.offsetHeight - box.clientHeight);
    const { height, scrolls } = boxSize(content, viewportHeight, expanded);
    box.style.height = `${height}px`;
    box.style.overflowY = scrolls ? 'auto' : 'hidden';
  }, [boxRef, text, expanded, viewportHeight]);
}

// --- the unsent draft -------------------------------------------------------------------------

/** What is kept of an unsent message: the typed text and the quotes above it. Never images. */
export interface StoredDraft {
  text: string;
  quotes: Quote[];
}
export const EMPTY_DRAFT: StoredDraft = { text: '', quotes: [] };
const hasContent = (draft: StoredDraft): boolean => draft.text.trim() !== '' || draft.quotes.length > 0;

/** A draft longer than this is not kept. A message can't be longer than 20 KB anyway. */
export const MAX_DRAFT_CHARS = 20_000;
/** The same for a draft with its quotes, which are stored unescaped and with their writers' names. */
const MAX_STORED_CHARS = 3 * MAX_DRAFT_CHARS;
/** One entry per participant, so a second person at the same browser gets their own draft. */
export const draftKey = (participant: string): string => `trialogDraft:${participant}`;
/**
 * Whose draft it is, and for which room: each room has its own unsent message. For `main` this is
 * the participant alone, so a draft from before rooms is still found. A name can't contain ":",
 * so no participant's entry can be mistaken for another one's room.
 */
export const draftScope = (participant: string, room: string): string => (room === 'main' ? participant : `${participant}:${room}`);

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// A draft without quotes is stored as its plain text, as it always was. One with quotes is stored
// as a small JSON object that says so with a version number, in the same entry.
const WITH_QUOTES = '{"v":1,';

/** The stored draft of this participant, or an empty one. Never throws: storage can be switched off. */
export function readDraft(storage: DraftStorage, participant: string): StoredDraft {
  try {
    const raw = storage.getItem(draftKey(participant));
    if (typeof raw !== 'string' || raw.length > MAX_STORED_CHARS) return EMPTY_DRAFT;
    if (raw.startsWith(WITH_QUOTES)) {
      try {
        const kept = JSON.parse(raw) as { v?: unknown; text?: unknown; quotes?: unknown };
        if (kept && kept.v === 1 && typeof kept.text === 'string') {
          return { text: kept.text.length <= MAX_DRAFT_CHARS ? kept.text : '', quotes: parseQuotes(kept.quotes) };
        }
      } catch { /* not ours after all: it is plain text that happens to start like this */ }
    }
    return raw.length <= MAX_DRAFT_CHARS ? { text: raw, quotes: [] } : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

/** Stores the draft, or removes the entry when there is nothing worth keeping. Never throws. */
export function writeDraft(storage: DraftStorage, participant: string, draft: StoredDraft): void {
  try {
    const key = draftKey(participant);
    const text = draft.text.length <= MAX_DRAFT_CHARS ? draft.text : '';
    // A quote is kept with the comment the writer put on it.
    const quotes = draft.quotes.map(({ author, messageId, kind, text: quoted, comment }) => (
      comment ? { author, messageId, kind, text: quoted, comment } : { author, messageId, kind, text: quoted }));
    const value = quotes.length ? JSON.stringify({ v: 1, text, quotes }) : text;
    if (!hasContent({ text, quotes }) || value.length > MAX_STORED_CHARS) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch { /* storage is full or off: the box works without it */ }
}

/**
 * What the composer should hold once the page knows who is signed in.
 *   current  what is in the composer now
 *   owner    whose that is: a participant, or null when nobody was known yet
 *   me       who is signed in now
 *   stored   that participant's stored draft
 * Something typed or quoted in the first moment, before the page knew who is signed in, is kept.
 * After a change of participant the composer shows the new participant's own draft, never the other's.
 */
export function draftFor(current: StoredDraft, owner: string | null, me: string, stored: StoredDraft): StoredDraft {
  if (owner === me) return current;
  if (owner === null && hasContent(current)) return current;
  return stored;
}

// --- the expand button ------------------------------------------------------------------------

/** Switches between the box that grows with its text and the tall writing area. */
export function ExpandButton({ expanded, onToggle, className }: { expanded: boolean; onToggle: () => void; className: string }) {
  const label = expanded ? 'Shrink the message box' : 'Enlarge the message box';
  return (
    <button type="button" className={className} aria-label={label} aria-pressed={expanded} title={label} onClick={onToggle}>
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="block h-[1.5em] w-4">
        {expanded
          // Two arrows pointing at each other: make it smaller.
          ? <path d="M3 3l3.5 3.5M6.5 3.2v3.3H3.2M13 13l-3.5-3.5M9.5 12.8V9.5h3.3" />
          // Two arrows pointing apart: make it larger.
          : <path d="M6.5 6.5L3 3M3 6.3V3h3.3M9.5 9.5L13 13M13 9.7V13H9.7" />}
      </svg>
    </button>
  );
}

export interface ComposerToolsProps {
  /** Who the message is for: '' is everyone. `recipients` are the other choices, in the roster's order. */
  to: string;
  onTo: (to: string) => void;
  recipients: readonly { name: string; label: string }[];
  emoji: { open: boolean; onOpenChange: (open: boolean) => void; onInsert: (char: string, focusBox: boolean) => void; boxRef: RefObject<HTMLTextAreaElement | null> };
  image: { disabled: boolean; onPick: () => void };
  decision: { open: boolean; onToggle: () => void };
  poll: { open: boolean; onToggle: () => void };
  expand: { expanded: boolean; onToggle: () => void };
  send: { disabled: boolean; label: string };
  /** The look of the recipient picker, and of every button in the row. */
  fieldClassName: string;
  toolClassName: string;
}

/**
 * The row under the message box. The recipient picker stays first, at the left. The actions
 * follow in the order they are used, the most frequent first: emoji, image, decision, poll.
 * Then the size of the box, the keyboard hint and, at the right, Send. The keyboard goes through
 * them in the same order, because nothing here sets a tab index: the order in the markup is both.
 */
export function ComposerTools({ to, onTo, recipients, emoji, image, decision, poll, expand, send, fieldClassName, toolClassName }: ComposerToolsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={to} onChange={(e) => onTo(e.target.value)} aria-label="Recipient" className={fieldClassName}>
        <option value="">to everyone</option>
        {recipients.map((r) => <option key={r.name} value={r.name}>to {r.label}</option>)}
      </select>
      <EmojiPicker open={emoji.open} onOpenChange={emoji.onOpenChange} onInsert={emoji.onInsert} boxRef={emoji.boxRef} buttonClassName={toolClassName} />
      <button
        type="button" className={toolClassName} onClick={image.onPick} disabled={image.disabled}
        title="Attach an image (PNG, JPEG or WebP). You can also paste one or drop it here."
      >Image</button>
      <button
        type="button" className={toolClassName} onClick={decision.onToggle}
        aria-pressed={decision.open} aria-expanded={decision.open} aria-controls={decision.open ? 'decision-composer' : undefined}
      >Decision</button>
      <button
        type="button" className={toolClassName} onClick={poll.onToggle}
        aria-pressed={poll.open} aria-expanded={poll.open} aria-controls={poll.open ? 'poll-composer' : undefined}
      >Poll</button>
      <ExpandButton expanded={expand.expanded} onToggle={expand.onToggle} className={toolClassName} />
      <span className="ml-auto hidden text-xs text-muted md:inline">Enter sends · Shift+Enter for a new line</span>
      <button type="submit" className={`${toolClassName} ml-auto md:ml-0`} disabled={send.disabled}>{send.label}</button>
    </div>
  );
}
