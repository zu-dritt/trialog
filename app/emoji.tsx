'use client';

// The emoji picker in the composer: a button that opens a small panel with a search field, the
// emojis used last, and the groups from emoji-data.ts.
//
// An emoji is plain Unicode text. Picking one inserts that text into the message box; nothing
// about a message changes on the server. The glyphs come from the reader's own system font, so
// nothing is fetched. The only thing stored is the list of recently used emojis, in this browser.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { ALL_EMOJIS, EMOJI_GROUPS, type Emoji } from './emoji-data';

export const RECENT_KEY = 'trialogRecentEmoji';
export const RECENT_MAX = 16;
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const BY_CHAR = new Map(ALL_EMOJIS.map((e) => [e.char, e]));

/**
 * The emojis that match a search. Every word typed must be the start of one of the emoji's words
 * ("thum up" finds thumbs up; "car" does not find "scared"). Pasting an emoji finds that emoji.
 * An empty search matches nothing: the panel then shows its groups instead.
 */
export function searchEmojis(query: string, emojis: Emoji[] = ALL_EMOJIS): Emoji[] {
  const typed = query.trim();
  if (!typed) return [];
  const exact = emojis.filter((e) => e.char === typed);
  if (exact.length) return exact;
  const terms = typed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!terms.length) return [];
  return emojis.filter((e) => terms.every((term) => e.words.some((word) => word.startsWith(term))));
}

/**
 * Puts `insert` into `text` where the cursor is, replacing the selection if there is one.
 * Returns the new text and where the cursor belongs afterwards: right behind what was inserted.
 * Positions are the ones a textarea reports (selectionStart, selectionEnd).
 */
export function insertAtCursor(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, end, text.length));
  const to = Math.min(text.length, Math.max(start, end, 0));
  return { text: text.slice(0, from) + insert + text.slice(to), cursor: from + insert.length };
}

/** The recent list after `char` was used: newest first, each emoji once, at most `max` long. */
export function pushRecent(recent: string[], char: string, max: number = RECENT_MAX): string[] {
  return [char, ...recent.filter((c) => c !== char)].slice(0, max);
}

/**
 * Reads the stored recent list. Whatever is in storage is checked: only emojis from our own list
 * come back, so a changed or broken value can never put other text on the page.
 */
export function parseRecent(stored: string | null | undefined, max: number = RECENT_MAX): string[] {
  if (!stored) return [];
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const known = value.filter((c): c is string => typeof c === 'string' && BY_CHAR.has(c));
  return [...new Set(known)].slice(0, max);
}

function loadRecent(): string[] {
  try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; }
}
function saveRecent(recent: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* storage is full or off: the picker works without it */ }
}

/** The panel is never taller than this, and never squeezed below PANEL_MIN_HEIGHT. */
const PANEL_MAX_HEIGHT = 352;
const PANEL_MIN_HEIGHT = 160;

interface PanelProps {
  id?: string;
  panelRef?: RefObject<HTMLDivElement | null>;
  /** The room above the composer, in pixels. The panel is kept inside it when it is known. */
  maxHeight?: number;
  /** Emojis to show in the "Recently used" row. */
  recent: string[];
  /** `viaPointer` is true for a mouse or touch pick, false for one made with the keyboard. */
  onPick: (char: string, viaPointer: boolean) => void;
}

/**
 * The panel itself. The emojis are real buttons, named for screen readers. The whole grid is one
 * stop for the Tab key; inside it the arrow keys, Home and End move, and Enter or Space picks.
 */
export function EmojiPanel({ id, panelRef, maxHeight, recent, onPick }: PanelProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(''); // the button the Tab key lands on
  const gridRef = useRef<HTMLDivElement>(null);

  const searching = query.trim() !== '';
  const sections = useMemo(() => {
    if (searching) return [{ id: 'results', label: 'Search results', emojis: searchEmojis(query) }];
    const used = recent.map((c) => BY_CHAR.get(c)).filter((e): e is Emoji => Boolean(e));
    return [...(used.length ? [{ id: 'recent', label: 'Recently used', emojis: used }] : []), ...EMOJI_GROUPS];
  }, [searching, query, recent]);
  const keys = sections.flatMap((s) => s.emojis.map((e) => `${s.id}:${e.char}`));
  const tabStop = keys.includes(active) ? active : keys[0];
  const count = searching ? sections[0].emojis.length : 0;

  /** Arrow keys follow what is on screen: up and down go to the nearest button in the next row. */
  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowRight') next = buttons[at + 1];
    else if (e.key === 'ArrowLeft') next = buttons[at - 1];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const here = buttons[at].getBoundingClientRect();
      const down = e.key === 'ArrowDown';
      const rows = buttons.map((b) => ({ b, r: b.getBoundingClientRect() })).filter(({ r }) => (down ? r.top > here.top + 1 : r.top < here.top - 1));
      if (rows.length) {
        const rowTop = down ? Math.min(...rows.map(({ r }) => r.top)) : Math.max(...rows.map(({ r }) => r.top));
        const row = rows.filter(({ r }) => Math.abs(r.top - rowTop) <= 1);
        next = row.reduce((best, c) => (Math.abs(c.r.left - here.left) < Math.abs(best.r.left - here.left) ? c : best)).b;
      }
    } else return;
    e.preventDefault();
    if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  };

  return (
    <div
      id={id} ref={panelRef} role="dialog" aria-label="Emoji"
      // It sits above the composer, which can be tall. So its height follows the room that is left.
      style={{ maxHeight: maxHeight === undefined ? `min(${PANEL_MAX_HEIGHT}px, 50vh)` : Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, maxHeight)) }}
      className="absolute bottom-full left-2 z-40 mb-1 flex w-[min(22rem,calc(100%-1rem))] flex-col rounded-lg border border-line bg-panel shadow-xl shadow-black/50"
    >
      <div className="border-b border-line p-2">
        <input
          type="search" value={query} placeholder="Search emoji" aria-label="Search emoji" autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter here must not send the message. It picks the first match instead.
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = searching ? sections[0].emojis[0] : undefined;
            if (first) onPick(first.char, false);
          }}
          className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
        />
        <div className="sr-only" aria-live="polite">{searching ? `${count} emoji found` : ''}</div>
      </div>
      <div ref={gridRef} onKeyDown={onGridKey} className="min-h-0 flex-1 overflow-y-auto p-2">
        {searching && count === 0 && <p className="px-1 py-3 text-sm text-muted">No emoji for “{query.trim()}”.</p>}
        {sections.map((s) => (s.emojis.length === 0 ? null : (
          <div key={s.id} role="group" aria-label={s.label} className="mb-2 last:mb-0">
            <div className="px-1 pb-1 text-[11px] font-bold uppercase tracking-[.06em] text-muted" aria-hidden="true">{s.label}</div>
            <div className="grid grid-cols-8 gap-0.5">
              {s.emojis.map((e) => {
                const key = `${s.id}:${e.char}`;
                return (
                  <button
                    key={key} type="button" data-emoji={e.char} aria-label={e.name} title={e.name}
                    tabIndex={key === tabStop ? 0 : -1}
                    onFocus={() => setActive(key)}
                    // Keep the focus where it is on a mouse click, so the cursor stays in the message box.
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={(ev) => onPick(e.char, ev.detail > 0)}
                    style={{ fontFamily: EMOJI_FONT }}
                    className="grid aspect-square cursor-pointer place-items-center rounded border-none bg-transparent p-0 text-[22px] leading-none hover:bg-[#2a2f3a] focus-visible:bg-[#2a2f3a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-david"
                  >{e.char}</button>
                );
              })}
            </div>
          </div>
        )))}
      </div>
    </div>
  );
}

interface PickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Puts the emoji into the message box. `focusBox` says whether the box should take the focus. */
  onInsert: (char: string, focusBox: boolean) => void;
  /** The message box, which gets the focus back when Escape closes the panel. */
  boxRef: RefObject<HTMLTextAreaElement | null>;
  buttonClassName: string;
}

/**
 * The button and, when open, the panel. The panel stays open after a pick, so several emojis can
 * be picked in a row. Escape or a click anywhere else closes it; so does sending, which the page
 * does by setting `open` to false.
 */
export function EmojiPicker({ open, onOpenChange, onInsert, boxRef, buttonClassName }: PickerProps) {
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  // The row of recent emojis is read when the panel opens and then left alone, so the buttons
  // don't move under the pointer while several are picked. The stored list is updated on every pick.
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { if (open) setRecent(loadRecent()); }, [open]);

  // How much room there is above the composer. It changes when the message box grows or the
  // window is resized, so it is measured again whenever either happens.
  const panelRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const anchor = open ? panelRef.current?.offsetParent : null;
    if (!anchor) return undefined;
    const measure = () => setRoom(Math.floor(anchor.getBoundingClientRect().top) - 8);
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(anchor);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = rootRef.current?.contains(document.activeElement);
      onOpenChange(false);
      if (inside) boxRef.current?.focus(); // don't leave the focus on a button that is gone
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      // The message box is not "outside": the reader may click into the text to move the cursor and go on picking.
      if (target && (rootRef.current?.contains(target) || boxRef.current?.contains(target))) return;
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, onOpenChange, boxRef]);

  const pick = (char: string, viaPointer: boolean) => {
    saveRecent(pushRecent(loadRecent(), char));
    // A pick by mouse or touch returns to the message box. A pick by keyboard stays in the panel,
    // so the next emoji is one arrow key away; the text still goes in at the cursor.
    onInsert(char, viaPointer);
  };

  return (
    <span ref={rootRef} className="contents">
      <button
        type="button" className={buttonClassName}
        aria-label="Emoji" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
        title="Add an emoji"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpenChange(!open)}
      ><span aria-hidden="true" style={{ fontFamily: EMOJI_FONT }}>🙂</span></button>
      {open && <EmojiPanel id={panelId} panelRef={panelRef} maxHeight={room} recent={recent} onPick={pick} />}
    </span>
  );
}
