'use client';

// Quote a selection: select part of a message in the stream, press Quote, and the selected text
// lands in the message box as a Markdown quote that says who wrote it and in which message.
//
//   > **Grok** in #45:
//   >
//   > the selected text
//
// Two things matter here. The quote is built as text and put into a text box: nothing from a
// message is ever turned into markup or run. And what was selected is what the reader saw, not
// the Markdown behind it, so it is escaped: a quoted "*" stays a star and a quoted "<b>" stays
// those three characters when the new message is shown.
import { useCallback, useEffect, useRef, useState } from 'react';

/** Marks the element that holds one message's text. Its value is the message id. */
export const MESSAGE_TEXT_ATTRIBUTE = 'data-message-text';

// Characters that start something in Markdown wherever they stand.
const INLINE = /[\\`*[\]<>|~]/g;
// An ampersand only matters where it starts a character reference: &name; &#123; or &#x1f;.
// Every other "&" is plain, and escaping it would put a backslash where none belongs.
const ENTITY = /&(?=(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)/g;
// An underscore only starts emphasis at the edge of a word; inside a word (snake_case) it is plain.
const EDGE_UNDERSCORE = /(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g;
// What would make a line a heading, a list item or a rule: "#", "-", "+", "=" or "1." at its start.
const LINE_START = /^(#|-|\+|=)/;
const ORDERED = /^(\d+)([.)])/;
// One thing is left to Markdown on purpose: a bare web address in the selection becomes a link,
// exactly as it does when someone types it into a message, with the same careful link rules
// (app/markdown.tsx). So an address must reach the renderer untouched: a backslash put inside it
// would end up in the link. What counts as an address here follows what the renderer links:
// "http://" or "https://" not directly after a letter, or "www." at the start or after a space or
// bracket; then a host name with a dot; then everything up to the next space or "<".
// Something that merely starts like an address (no proper host name) is escaped like all other text.
const ADDRESS = /(?:(?<![A-Za-z])https?:\/\/|(?<![^\s(])(?=www\.))(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+[^\s<]*/g;
// What the renderer leaves out of a link at its end: closing punctuation, and something that
// looks like a character reference. Those are text again, and are escaped as text.
const ADDRESS_TAIL = /(?:&[A-Za-z0-9#]+;|[!"'*,.:;?_~])+$/;

/** Cuts off what the renderer will not count as part of the link. */
function linkedPart(address: string): string {
  let linked = address;
  for (;;) {
    const before = linked;
    linked = linked.replace(ADDRESS_TAIL, '');
    // A closing bracket belongs to the address only when it has its opening one inside it.
    for (const [open, close] of ['()', '[]']) {
      if (linked.endsWith(close) && linked.split(close).length > linked.split(open).length) linked = linked.slice(0, -1);
    }
    if (linked === before) return linked;
  }
}

/** Escapes text that is not a web address. */
const escapeText = (text: string): string => text.replace(INLINE, '\\$&').replace(ENTITY, '\\&').replace(EDGE_UNDERSCORE, '\\_');

/** Escapes one line so that Markdown shows it as the plain text it is. */
function escapeLine(line: string): string {
  const trimmed = line.trim();
  let escaped = '';
  let done = 0;
  for (const match of trimmed.matchAll(ADDRESS)) {
    const address = linkedPart(match[0]);
    escaped += escapeText(trimmed.slice(done, match.index)) + address;
    done = match.index + address.length;
  }
  escaped += escapeText(trimmed.slice(done));
  return escaped.replace(LINE_START, '\\$1').replace(ORDERED, '$1\\$2');
}

/** Selected text, escaped line by line so that Markdown renders it as that same text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(escapeLine).join('\n');
}

const HEADER = (author: string, id: number) => `> **${author}** in #${id}:`;
/** Drops empty lines at both ends and folds runs of them into one. */
const tidy = (lines: string[]): string[] => lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '').split('\n');

/**
 * The quote for text selected in a message, as the reader saw it. Each line of the selection
 * stays a line of its own: two spaces at the end of a line are Markdown's line break.
 */
export function quoteSelection(author: string, id: number, selected: string): string {
  const lines = tidy(escapeMarkdown(selected).split('\n'));
  const body = lines.map((line, i) => {
    if (line === '') return '>';
    const nextIsText = i + 1 < lines.length && lines[i + 1] !== '';
    return `> ${line}${nextIsText ? '  ' : ''}`;
  });
  return [HEADER(author, id), '>', ...body].join('\n');
}

/**
 * The quote for a whole message. This uses the message's own Markdown source, unchanged, so a
 * list stays a list and code stays code, exactly as in the message that is quoted.
 */
export function quoteMessage(author: string, id: number, source: string): string {
  const lines = tidy(source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()));
  return [HEADER(author, id), '>', ...lines.map((line) => (line === '' ? '>' : `> ${line}`))].join('\n');
}

/**
 * Puts a quote into the message box at the cursor (replacing a selection there). The quote gets
 * a paragraph of its own, and an empty line follows it; the cursor ends up after that line, on a
 * line of its own. Text that stood behind the cursor follows as its own paragraph, so what is
 * typed next never runs into it.
 */
export function insertQuote(text: string, start: number, end: number, quote: string): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, end, text.length));
  const to = Math.min(text.length, Math.max(start, end, 0));
  const before = text.slice(0, from).replace(/[ \t]+$/, '');
  const after = text.slice(to).replace(/^[ \t]+/, '').replace(/^\n+/, '');
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const head = `${before}${lead}${quote}\n\n`;
  return { text: head + (after === '' ? '' : `\n\n${after}`), cursor: head.length };
}

/** The parts of a browser Selection this needs; tests pass a plain object. */
export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: unknown;
  focusNode: unknown;
  toString(): string;
}
interface ElementLike { closest?: (selector: string) => ElementLike | null; getAttribute?: (name: string) => string | null; parentElement?: ElementLike | null }

/** The element that holds a message's text and contains this node, or null. */
function messageTextOf(node: unknown): ElementLike | null {
  const n = node as ElementLike | null;
  if (!n) return null;
  // A text node has no closest(); its parent element has.
  const element = typeof n.closest === 'function' ? n : n.parentElement;
  return element?.closest?.(`[${MESSAGE_TEXT_ATTRIBUTE}]`) ?? null;
}

/**
 * What a selection offers to quote: the message it lies in and the selected text. Null when
 * nothing is selected, when the selection reaches outside the text of one message (into a
 * second message, a name, a time, the page), or when it holds only white space.
 */
export function pickSelection(selection: SelectionLike | null | undefined): { messageId: number; text: string } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const from = messageTextOf(selection.anchorNode);
  const to = messageTextOf(selection.focusNode);
  if (!from || from !== to) return null;
  const messageId = Number(from.getAttribute?.(MESSAGE_TEXT_ATTRIBUTE));
  const text = selection.toString().trim();
  if (!Number.isInteger(messageId) || messageId <= 0 || text === '') return null;
  return { messageId, text };
}

export interface PickedQuote {
  messageId: number;
  text: string;
  /** Where the Quote button goes, in window coordinates. */
  top: number;
  left: number;
}

const BUTTON_WIDTH = 76;
const BUTTON_HEIGHT = 30;

/** A place for the button next to the end of the selection: below it, or above when there is no room. */
export function placeButton(first: { top: number }, last: { bottom: number; right: number }, viewport: { width: number; height: number }): { top: number; left: number } {
  const below = last.bottom + 6;
  const top = below + BUTTON_HEIGHT + 8 <= viewport.height ? below : Math.max(8, first.top - BUTTON_HEIGHT - 6);
  const left = Math.min(Math.max(8, last.right - BUTTON_WIDTH), Math.max(8, viewport.width - BUTTON_WIDTH - 8));
  return { top: Math.round(top), left: Math.round(left) };
}

/**
 * Watches the selection on the page. Returns what can be quoted right now, or null, and a
 * function that drops it. While a mouse button or a finger is down the answer doesn't change, so
 * the button doesn't chase the pointer during a drag.
 */
export function useQuotableSelection(): [PickedQuote | null, () => void] {
  const [picked, setPicked] = useState<PickedQuote | null>(null);
  const pointerDown = useRef(false);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      const selection = window.getSelection();
      const pick = pickSelection(selection);
      if (!pick || !selection) { setPicked(null); return; }
      const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      if (!rects.length) { setPicked(null); return; }
      const place = placeButton(rects[0], rects[rects.length - 1], { width: window.innerWidth, height: window.innerHeight });
      setPicked({ ...pick, ...place });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (!pointerDown.current) read(); });
    };
    const down = () => { pointerDown.current = true; };
    const up = () => { pointerDown.current = false; schedule(); };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    // The selection moves with the page, so the button has to follow.
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  }, []);
  return [picked, clear];
}

/** The small button that appears next to selected message text. */
export function QuoteSelectionButton({ at, onQuote }: { at: { top: number; left: number }; onQuote: () => void }) {
  return (
    <button
      type="button" data-quote-selection aria-label="Quote the selected text in your message" title="Quote the selected text in your message"
      style={{ top: at.top, left: at.left }}
      // Pressing the button must not clear the selection it is about.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onQuote}
      className="fixed z-30 cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-1 text-[13px] font-semibold text-fg shadow-lg shadow-black/50 hover:bg-[#343a47]"
    >Quote</button>
  );
}

/** The Quote action in a message's header line: reachable with Tab, and quotes the whole message when nothing in it is selected. */
export function QuoteMessageButton({ messageId, onQuote, className }: { messageId: number; onQuote: () => void; className: string }) {
  const label = `Quote message #${messageId}`;
  return (
    <button type="button" aria-label={label} title={`${label} (or the part of it you selected)`} onMouseDown={(e) => e.preventDefault()} onClick={onQuote} className={className}>Quote</button>
  );
}
