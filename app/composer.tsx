'use client';

// The message box: how tall it is, and keeping an unsent draft across a reload.
//
// The box grows with its text, line by line, up to a share of the window, and scrolls after
// that. A button switches it to a tall writing area and back. The text of an unsent message is
// kept in this browser per participant, so a reload doesn't lose it. Only the text: no images,
// and nothing leaves the browser.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

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

/** A draft longer than this is not kept. A message can't be longer than 20 KB anyway. */
export const MAX_DRAFT_CHARS = 20_000;
/** One entry per participant, so a second person at the same browser gets their own draft. */
export const draftKey = (participant: string): string => `trialogDraft:${participant}`;

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The stored draft of this participant, or ''. Never throws: storage can be switched off. */
export function readDraft(storage: DraftStorage, participant: string): string {
  try {
    const text = storage.getItem(draftKey(participant));
    return typeof text === 'string' && text.length <= MAX_DRAFT_CHARS ? text : '';
  } catch {
    return '';
  }
}

/** Stores the draft, or removes the entry when there is nothing worth keeping. Never throws. */
export function writeDraft(storage: DraftStorage, participant: string, text: string): void {
  try {
    if (text.trim() === '' || text.length > MAX_DRAFT_CHARS) storage.removeItem(draftKey(participant));
    else storage.setItem(draftKey(participant), text);
  } catch { /* storage is full or off: the box works without it */ }
}

/**
 * What the message box should hold once the page knows who is signed in.
 *   current  what is in the box now
 *   owner    whose text that is: a participant, or null when nobody was known yet
 *   me       who is signed in now
 *   stored   that participant's stored draft
 * Text typed in the first moment, before the page knew who is signed in, is kept. After a
 * change of participant the box shows the new participant's own draft, never the other's.
 */
export function draftFor(current: string, owner: string | null, me: string, stored: string): string {
  if (owner === me) return current;
  if (owner === null && current.trim() !== '') return current;
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
