'use client';

// Quote a selection: select part of a message in the stream and press Quote. The quote becomes a
// chip above the message box, next to images and the "Replying to" marker, and the box stays
// free for what the writer wants to say. Several quotes can be collected.
//
// When the message is sent, the chips are written out as Markdown in front of the typed text:
//
//   > **Grok** in #45:
//   >
//   > the selected text
//
// So a message with quotes is ordinary Markdown text for the server, the API, the command-line
// client and every agent that reads it. Two things matter here. A quote is text from start to
// end: nothing from a message is ever turned into markup or run. And what was selected is what
// the reader saw, not the Markdown behind it, so it is escaped: a quoted "*" stays a star and a
// quoted "<b>" stays those three characters when the new message is shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_TEXT_BYTES, addressing } from '../lib/shared';
import { Chip } from './chips';

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
// What does not belong to a link at its end: closing punctuation, something that looks like a
// character reference, and the ">" of an address written in angle brackets. Those are text again.
const ADDRESS_TAIL = /(?:&[A-Za-z0-9#]+;|[!"'*,.:;?_~>])+$/;
// The characters directly behind an address can't be escaped with a backslash: the renderer would
// take the backslash for one more character of the address. A character reference does the same
// job, and the renderer knows that one is never part of a link.
const TAIL_REFERENCE: Record<string, string> = { '*': '&ast;', _: '&lowbar;', ']': '&rsqb;', '>': '&gt;' };

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
    const linked = linkedPart(match[0]);
    // What stands directly behind the link, up to the next space: written without backslashes.
    const end = match.index + match[0].length;
    const tail = trimmed.slice(match.index + linked.length, end).replace(/[*_\]>]/g, (c) => TAIL_REFERENCE[c]);
    escaped += escapeText(trimmed.slice(done, match.index)) + linked + tail;
    done = end;
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

// --- quotes as chips ------------------------------------------------------------------------

/** At most this many quotes travel with one message. */
export const MAX_QUOTES = 5;

/** One quote waiting above the message box. */
export interface Quote {
  /** The display name of the writer of the quoted message, as it was shown. */
  author: string;
  messageId: number;
  /** 'selection': text as the reader saw it, to be escaped. 'message': a whole message, in its own Markdown. */
  kind: 'selection' | 'message';
  text: string;
}
/** A quote on the page, with a key that tells two chips apart. */
export interface QuoteChip extends Quote { key: number }

const sameQuote = (a: Quote, b: Quote) => a.messageId === b.messageId && a.kind === b.kind && a.text === b.text;

/**
 * The list of quotes after one more was asked for. The same quote twice is kept once, and beyond
 * MAX_QUOTES nothing is added: `refused` says which of the two happened, so the page can say so.
 */
export function addQuote<Q extends Quote>(quotes: Q[], quote: Q, max: number = MAX_QUOTES): { quotes: Q[]; refused: 'duplicate' | 'full' | null } {
  if (quotes.some((q) => sameQuote(q, quote))) return { quotes, refused: 'duplicate' };
  if (quotes.length >= max) return { quotes, refused: 'full' };
  return { quotes: [...quotes, quote], refused: null };
}

/** One quote as Markdown. */
export const quoteMarkdown = (q: Quote): string => (q.kind === 'message' ? quoteMessage(q.author, q.messageId, q.text) : quoteSelection(q.author, q.messageId, q.text));

/**
 * The text that is sent: every quote in order, each followed by an empty line, then what was
 * typed. With no quotes it is exactly what was typed, so a plain message is untouched.
 */
export function composeMessage(quotes: Quote[], typed: string): string {
  if (!quotes.length) return typed;
  const quoted = quotes.map(quoteMarkdown).join('\n\n');
  return typed.trim() === '' ? quoted : `${quoted}\n\n${typed}`;
}

/** The size of a text as the server counts it: bytes of UTF-8. */
export const textBytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Says so when the composed message is over the limit, and by how much it helps to know. Null
 * when it fits. The server would refuse it too; this is for telling the writer before sending.
 */
export function tooLong(composed: string, quoteCount: number, max: number = MAX_TEXT_BYTES): string | null {
  const bytes = textBytes(composed);
  if (bytes <= max) return null;
  // Rounded up, so a message that is only just too long is not reported as being exactly at the limit.
  const size = (Math.ceil((bytes / 1024) * 10) / 10).toFixed(1);
  const limit = `${max / 1024} KB`;
  return quoteCount > 0
    ? `With its quote${quoteCount === 1 ? '' : 's'} this message is ${size} KB. The limit is ${limit}: remove a quote or shorten the text.`
    : `This message is ${size} KB. The limit is ${limit}.`;
}

/**
 * What the typed text asks for by the way it starts: "@name" addresses someone, "DECISION:" pins.
 * The server reads both from the start of the message text. With quotes in front, the typed text
 * no longer is that start, so the page reads them here and asks for the same things explicitly.
 */
export function typedIntent(typed: string, names: readonly string[]): { to: string | null; decision: boolean } {
  // The server's own two rules (addressing in lib/shared.ts): the name in any case, DECISION: in capitals.
  const { mention, decision } = addressing(names);
  const found = mention.exec(typed);
  return { to: found ? found[1].toLowerCase() : null, decision: decision.test(typed) };
}

/**
 * A few words of a quote for its chip: white space folded, cut with an ellipsis. A whole message
 * is kept as its Markdown source; for the chip, the backslashes of its escapes are left out, so
 * the few words read the way the message did.
 */
export function quoteExcerpt(text: string, max = 60, kind: Quote['kind'] = 'selection'): string {
  const shown = kind === 'message' ? text.replace(/\\([!-/:-@[-`{-~])/g, '$1') : text;
  const flat = shown.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Reads quotes that were kept in storage. Whatever is there is checked piece by piece, and
 * anything that is not a quote is dropped, so a changed or broken value can't break the page.
 */
export function parseQuotes(value: unknown, max: number = MAX_QUOTES): Quote[] {
  if (!Array.isArray(value)) return [];
  const quotes: Quote[] = [];
  for (const item of value as Partial<Quote>[]) {
    if (!item || typeof item !== 'object') continue;
    const { author, messageId, kind, text } = item;
    if (typeof author !== 'string' || author.trim() === '' || author.length > 80) continue;
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1) continue;
    if (kind !== 'selection' && kind !== 'message') continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    const quote: Quote = { author, messageId, kind, text };
    if (!quotes.some((q) => sameQuote(q, quote)) && quotes.length < max) quotes.push(quote);
  }
  return quotes;
}

/** The quotes above the message box, as chips. */
export function QuoteChips({ quotes, onRemove }: { quotes: QuoteChip[]; onRemove: (key: number) => void }) {
  return (
    <>
      {quotes.map((q) => (
        <Chip
          key={q.key} visual="↳" title={q.text.length > 1200 ? `${q.text.slice(0, 1200)}…` : q.text}
          onRemove={() => onRemove(q.key)} removeLabel={`Remove the quote from ${q.author}, #${q.messageId}`}
        >
          <span className="font-bold">{q.author}</span>, #{q.messageId} <span className="text-muted">“{quoteExcerpt(q.text, 60, q.kind)}”</span>
        </Chip>
      ))}
    </>
  );
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
