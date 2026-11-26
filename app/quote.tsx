'use client';

// Quote a selection: select part of a message in the stream and press Quote. A small box opens at
// the selection, where the writer can say something about those words; Enter makes the quote a
// chip above the message box, next to images and the "Replying to" marker. The message box stays
// free for what else the writer wants to say. Several quotes can be collected, each with its own
// comment.
//
// When the message is sent, the chips are written out as Markdown in front of the typed text,
// each followed by its comment:
//
//   > **Grok** in #45:
//   >
//   > the selected text
//
//   what the writer says about it
//
// So a message with quotes is ordinary Markdown text for the server, the API, the command-line
// client and every agent that reads it. Two things matter here. A quote is text from start to
// end: nothing from a message is ever turned into markup or run. And what was selected is what
// the reader saw, not the Markdown behind it, so it is escaped: a quoted "*" stays a star and a
// quoted "<b>" stays those three characters when the new message is shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_TEXT_BYTES, addressing } from '../lib/shared';
import { Chip } from './chips';
import { isDecision } from './decision';

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
  /**
   * What the writer says about this quote. It is their own Markdown, like the main text, and is
   * sent right below the quote. Left out or empty: the quote stands alone.
   */
  comment?: string;
}
/** A quote on the page, with a key that tells two chips apart. */
export interface QuoteChip extends Quote { key: number }

/** A comment on one quote can be this long. (The whole message has its own limit of 20 KB.) */
export const MAX_COMMENT_CHARS = 4000;

/** The same words of the same message, quoted the same way. A comment makes no difference. */
export const sameQuote = (a: Quote, b: Quote): boolean => a.messageId === b.messageId && a.kind === b.kind && a.text === b.text;

/** A comment as it is kept and sent: no empty lines around it, no white space at its end. Empty when there is nothing to say. */
export const tidyComment = (comment: string | undefined): string => (comment ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

/** A quote with this comment, or without one when the comment is empty. */
export function withComment<Q extends Quote>(quote: Q, comment: string | undefined): Q {
  const tidy = tidyComment(comment);
  const { comment: _old, ...rest } = quote;
  return (tidy === '' ? rest : { ...rest, comment: tidy }) as Q;
}

/**
 * The list of quotes after one more was asked for. The same quote twice is kept once, and beyond
 * MAX_QUOTES nothing is added: `refused` says which of the two happened, so the page can say so.
 */
export function addQuote<Q extends Quote>(quotes: Q[], quote: Q, max: number = MAX_QUOTES): { quotes: Q[]; refused: 'duplicate' | 'full' | null } {
  if (quotes.some((q) => sameQuote(q, quote))) return { quotes, refused: 'duplicate' };
  if (quotes.length >= max) return { quotes, refused: 'full' };
  return { quotes: [...quotes, quote], refused: null };
}

/** What to tell the writer when a quote was not added. Empty when it was. */
export const quoteNotice = (refused: 'duplicate' | 'full' | null): string => {
  if (refused === 'full') return `A message can carry at most ${MAX_QUOTES} quotes.`;
  // Without a word, a second click on the same selection looks like a button that does nothing.
  return refused === 'duplicate' ? 'That quote is already attached to your message.' : '';
};

/** One quote as Markdown. */
export const quoteMarkdown = (q: Quote): string => (q.kind === 'message' ? quoteMessage(q.author, q.messageId, q.text) : quoteSelection(q.author, q.messageId, q.text));

/** One quote as it is sent: the quote, and below it, after an empty line, what the writer says about it. */
export function quoteBlock(q: Quote): string {
  const comment = tidyComment(q.comment);
  return comment === '' ? quoteMarkdown(q) : `${quoteMarkdown(q)}\n\n${comment}`;
}

/**
 * The text that is sent: every quote in the order it was added, each followed by its comment
 * (when it has one) and an empty line, then what was typed in the message box. With no quotes it
 * is exactly what was typed, so a plain message is untouched. A message may be quotes and
 * comments only.
 */
export function composeMessage(quotes: Quote[], typed: string): string {
  if (!quotes.length) return typed;
  const quoted = quotes.map(quoteBlock).join('\n\n');
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
 * What a message with quotes asks for, which the page then asks of the server explicitly (the
 * server reads only the very start of the text, and there a quote stands).
 *
 *   to        Only "@name" at the start of the message box counts. A quote never addresses
 *             anyone, and neither does a comment on a quote, whatever it starts with.
 *   decision  The message is a decision when the first thing its writer says in it starts with
 *             DECISION: (after an optional "@name"). That first thing is the comment under the
 *             first quote, or, when the quotes before it have no comment, the message box. This
 *             is exactly what the Decision badge reads from the sent message (isDecision), so the
 *             pin and the badge agree. A DECISION: in a later comment or further down is text.
 */
export function composedIntent(quotes: Quote[], typed: string, names: readonly string[]): { to: string | null; decision: boolean } {
  return { to: typedIntent(typed, names).to, decision: isDecision(composeMessage(quotes, typed), names) };
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
    const { author, messageId, kind, text, comment } = item;
    if (typeof author !== 'string' || author.trim() === '' || author.length > 80) continue;
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1) continue;
    if (kind !== 'selection' && kind !== 'message') continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    // A comment that is not text, or far too long, is dropped; the quote itself is kept.
    const quote: Quote = withComment({ author, messageId, kind, text }, typeof comment === 'string' && comment.length <= MAX_COMMENT_CHARS ? comment : undefined);
    if (!quotes.some((q) => sameQuote(q, quote)) && quotes.length < max) quotes.push(quote);
  }
  return quotes;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** What a chip says when the pointer rests on it: the quoted text, and below it the writer's comment. */
export function chipTooltip(q: Quote): string {
  const comment = tidyComment(q.comment);
  return comment === '' ? cut(q.text, 1200) : `${cut(q.text, 800)}\n\nYour comment: ${cut(comment, 400)}`;
}

/**
 * The quotes above the message box, as chips. A chip shows who, which message and the first
 * words. One that carries a comment says so with a quiet "with reply". A click on a chip (or
 * Enter on it) opens its comment for writing or changing.
 */
export function QuoteChips({ quotes, onRemove, onEdit }: { quotes: QuoteChip[]; onRemove: (key: number) => void; onEdit?: (key: number) => void }) {
  return (
    <>
      {quotes.map((q) => {
        const commented = tidyComment(q.comment) !== '';
        const from = `the quote from ${q.author}, #${q.messageId}`;
        const words = <><span className="font-bold">{q.author}</span>, #{q.messageId} <span className="text-muted">“{quoteExcerpt(q.text, commented ? 40 : 60, q.kind)}”</span></>;
        return (
          <Chip
            key={q.key} visual="↳" title={chipTooltip(q)}
            onRemove={() => onRemove(q.key)} removeLabel={`Remove ${from}`}
            onOpen={onEdit ? () => onEdit(q.key) : undefined} openLabel={commented ? `Edit your comment on ${from}` : `Add a comment to ${from}`}
          >
            {/* The marker stands outside the part that is cut, so a long quote never hides it. */}
            {commented
              ? <span className="flex items-baseline"><span className="min-w-0 truncate">{words}</span><span className="flex-none pl-1 text-muted">· with reply</span></span>
              : words}
          </Chip>
        );
      })}
    </>
  );
}

// --- a comment on a quote ---------------------------------------------------------------------

const BOX_WIDTH = 352;
const BOX_HEIGHT = 132;

/**
 * Where the comment box goes when it opens at a selection or at a Quote button: at that spot,
 * moved as far as needed to lie inside the window.
 */
export function placeCommentBox(at: { top: number; left: number }, viewport: { width: number; height: number }): { top: number; left: number; width: number } {
  const width = Math.min(BOX_WIDTH, Math.max(0, viewport.width - 16));
  const left = Math.max(8, Math.min(at.left, viewport.width - width - 8));
  const top = Math.max(8, Math.min(at.top, viewport.height - BOX_HEIGHT - 8));
  return { top: Math.round(top), left: Math.round(left), width };
}

/** What a key in the comment line does. Enter adds the quote; with Shift it makes a new line. */
export function commentKey(key: string, shift: boolean, composing: boolean): 'submit' | 'cancel' | null {
  if (key === 'Escape') return 'cancel';
  return key === 'Enter' && !shift && !composing ? 'submit' : null;
}

/**
 * The small box in which a quote gets its comment: the quoted words on top, and one line below
 * for what the writer wants to say about them. Enter (or the button) adds the quote, with the
 * comment if there is one; Escape cancels. The line may stay empty: then the quote is added alone.
 *
 *   at       Opened at a selection or a Quote button: the box floats there, and a click anywhere
 *            else cancels it. Without `at` the box stands in the page (above the message box,
 *            to change the comment of a chip) and stays until it is saved or cancelled.
 *   editing  The quote is already a chip: the button says "Save" and the dialog is named for that.
 */
export function QuoteCommentBox({ quote, at, editing = false, onSubmit, onCancel }: {
  quote: Quote;
  at?: { top: number; left: number } | null;
  editing?: boolean;
  onSubmit: (comment: string) => void;
  /** `how` says what cancelled it: the Escape key, or a press somewhere outside the box. */
  onCancel: (how: 'escape' | 'outside') => void;
}) {
  const [comment, setComment] = useState(quote.comment ?? '');
  const root = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);
  const floating = Boolean(at);

  // The cursor goes into the line at once, behind what is already there.
  useEffect(() => {
    const el = line.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // The line grows with its text, up to a few lines.
  useEffect(() => {
    const el = line.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 132)}px`;
  }, [comment]);
  useEffect(() => {
    if (!at) { setPlace(null); return undefined; }
    const fit = () => setPlace(placeCommentBox(at, { width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight }));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [at]);
  // A floating box is cancelled by a press anywhere outside it.
  useEffect(() => {
    if (!floating) return undefined;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node | null)) cancelRef.current('outside'); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [floating]);

  const name = editing ? `Your comment on the quote from ${quote.author}, #${quote.messageId}` : `Quote ${quote.author}, #${quote.messageId}, with a comment`;
  return (
    <div
      ref={root} role="dialog" aria-label={name} data-quote-comment
      style={floating ? { top: place?.top ?? at?.top, left: place?.left ?? at?.left, width: place?.width } : undefined}
      className={floating
        ? 'fixed z-40 rounded-lg border border-line bg-panel p-2 text-[13px] shadow-xl shadow-black/50'
        : 'mb-2 rounded-lg border border-line bg-panel p-2 text-[13px]'}
    >
      <div className="mb-1.5 truncate text-muted" title={cut(quote.text, 1200)}>
        <span aria-hidden="true">↳ </span><span className="font-bold text-fg">{quote.author}</span>, #{quote.messageId} “{quoteExcerpt(quote.text, 70, quote.kind)}”
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={line} rows={1} value={comment} maxLength={MAX_COMMENT_CHARS}
          placeholder="Add a comment (optional)" aria-label="Your comment on this quote"
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            const does = commentKey(e.key, e.shiftKey, e.nativeEvent.isComposing);
            if (!does) return;
            e.preventDefault();
            e.stopPropagation(); // Escape here closes this box and nothing else
            if (does === 'submit') onSubmit(comment); else onCancel('escape');
          }}
          className="min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
        />
        <button
          type="button" onClick={() => onSubmit(comment)}
          title={editing ? 'Save your comment (Enter)' : 'Add the quote to your message (Enter)'}
          className="flex-none cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-2.5 py-1.5 text-[13px] font-semibold hover:bg-[#343a47]"
        >{editing ? 'Save' : 'Add'}</button>
      </div>
      <div className="mt-1 text-[11px] text-muted">Enter {editing ? 'saves' : 'adds the quote'} · Shift+Enter for a new line · Esc cancels</div>
    </div>
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

/** After a press on the Quote button has ended, the button stays this long for the click to arrive. */
export const PRESS_GRACE_MS = 800;

/**
 * Keeps the Quote button in place while it is being pressed. A press on the button is a mouse
 * button or a finger going down on it, and the click that follows. Between the two a browser may
 * drop the selection the button stands for: a tap on a phone or tablet does that, and delivers
 * its click a moment after the finger has left. If the page looked at the selection in that
 * moment it would find nothing to quote and take the button away, and the click would land on
 * nothing. So from the press until the click (or `graceMs` after the release, if no click
 * comes), the page must not look.
 */
export function createPressHold(graceMs: number = PRESS_GRACE_MS, now: () => number = () => Date.now()) {
  let pressed = false;
  let until = 0;
  return {
    /** A mouse button or a finger went down on the Quote button. */
    press() { pressed = true; },
    /** It went up again. The click may still be on its way. */
    release() { if (pressed) { pressed = false; until = now() + graceMs; } },
    /** The click arrived and was handled, or there is nothing to hold any more. */
    done() { pressed = false; until = 0; },
    /** Whether the button must stay as it is: the selection is not to be read now. */
    holding(): boolean { return pressed || now() < until; },
    pressed(): boolean { return pressed; },
  };
}

/** Whether an event's target is the Quote button (or something inside it). */
export const isQuoteButton = (target: unknown): boolean =>
  typeof (target as ElementLike | null)?.closest === 'function' && (target as ElementLike).closest!('[data-quote-selection]') !== null;

/**
 * Watches the selection on the page. Returns what can be quoted right now, or null, and a
 * function that drops it. While a mouse button or a finger is down the answer doesn't change, so
 * the button doesn't chase the pointer during a drag. And while the Quote button itself is being
 * pressed, the answer stays until the click has arrived (see createPressHold).
 */
export function useQuotableSelection(): [PickedQuote | null, () => void] {
  const [picked, setPicked] = useState<PickedQuote | null>(null);
  const pointerDown = useRef(false);
  const hold = useRef(createPressHold());

  useEffect(() => {
    let frame = 0;
    let afterGrace: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (hold.current.holding()) return; // the Quote button is being pressed: leave it where it is
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
    const down = (e: Event) => {
      pointerDown.current = true;
      if (isQuoteButton(e.target)) hold.current.press();
    };
    const up = () => {
      pointerDown.current = false;
      if (hold.current.pressed()) {
        hold.current.release();
        // If no click comes (the press was moved off the button), look again once the wait is over.
        clearTimeout(afterGrace);
        afterGrace = setTimeout(schedule, PRESS_GRACE_MS + 20);
      }
      schedule();
    };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    // The selection moves with the page, so the button has to follow.
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(afterGrace);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  const clear = useCallback(() => {
    hold.current.done();
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
export function QuoteMessageButton({ messageId, onQuote, className }: {
  messageId: number;
  /** `at` is the spot right under the button, in window coordinates: where the comment box opens. */
  onQuote: (at: { top: number; left: number }) => void;
  className: string;
}) {
  const label = `Quote message #${messageId}`;
  return (
    <button
      type="button" aria-label={label} title={`${label} (or the part of it you selected)`} className={className}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onQuote({ top: r.bottom + 6, left: r.right - BOX_WIDTH }); }}
    >Quote</button>
  );
}
