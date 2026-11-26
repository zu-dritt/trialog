'use client';

// Search on the page: a field in the header, and under it a panel with the messages that contain
// every word typed, newest first. A click on a result goes to that message in the stream.
//
// What a result shows of a message is plain text, cut into pieces so the matching words can be
// marked. It is never rendered as Markdown or HTML, so nothing in a message can turn into markup
// here. The rules of a query (lib/search.ts) are the same ones the server uses.
import { useEffect, useId, useRef, useState } from 'react';
import type { Message } from '../lib/core';
import { isDecision } from '../lib/decision';
import { colorOf, displayName, type Participant } from '../lib/shared';
import { DecisionBadge } from './decision';
import { SEARCH_LIMIT, debounce, markMatches, matchLine, newestOnly, parseQuery } from '../lib/search';

/** How long the page waits after the last key before it asks the server. */
export const SEARCH_WAIT_MS = 250;

const whenFmt = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** The same wording as the server's, said to a person instead of a program. */
export const queryProblem = (error: string): string => error.replace('"q"', 'A search');

export type SearchState =
  | { kind: 'idle' }
  | { kind: 'problem'; message: string }
  | { kind: 'searching' }
  | { kind: 'done'; results: Message[]; words: string[] };

interface Look {
  /** Who takes part (GET /api/participants): for the colours, and for the rule of a decision. */
  participants: readonly Participant[];
}

/** The list of results. Each one is an option of the search field's list box. */
export function SearchResults({ listId, results, words, active, onPick, onPoint, participants }: Look & {
  listId: string;
  results: Message[];
  words: string[];
  /** The index of the result the keyboard is on, or -1. */
  active: number;
  onPick: (m: Message) => void;
  onPoint?: (index: number) => void;
}) {
  const names = participants.map((p) => p.name);
  return (
    <ul id={listId} role="listbox" aria-label="Search results" className="max-h-[min(60vh,420px)] overflow-auto">
      {results.map((m, i) => (
        <li
          key={m.id} id={`${listId}-${m.id}`} role="option" aria-selected={i === active}
          onMouseMove={() => onPoint?.(i)}
          onClick={() => onPick(m)}
          className={`cursor-pointer border-t border-line px-3 py-1.5 ${i === active ? 'bg-[#2a2f3a]' : ''}`}
        >
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <span className="font-bold" style={{ color: colorOf(m.sender, participants) }}>{displayName(m.sender)}</span>
            <time dateTime={m.created_at}>{whenFmt.format(new Date(m.created_at))}</time>
            <span>#{m.id}</span>
            {/* The same two signs as in the stream: the badge for a decision, the word for a pin. */}
            {isDecision(m.text, names, m.decision) && <DecisionBadge />}
            {m.pinned_at && <span>pinned</span>}
          </div>
          <div className="truncate text-[13px]">
            {markMatches(matchLine(m, words), words).map((piece, j) => (piece.hit
              ? <mark key={j} className="rounded-sm bg-decision/35 text-fg">{piece.text}</mark>
              : <span key={j}>{piece.text}</span>))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** What the panel says when it has no list to show, or under the list. */
export function searchNote(state: SearchState, decisionsOnly: boolean): string {
  if (state.kind === 'idle') return 'Type a word or two. A message is found when it contains all of them.';
  if (state.kind === 'problem') return state.message;
  if (state.kind === 'searching') return 'Searching…';
  if (!state.results.length) return decisionsOnly ? 'No decision found.' : 'Nothing found.';
  return state.results.length >= SEARCH_LIMIT ? `These are the newest ${SEARCH_LIMIT}. Add a word to narrow it down.` : '';
}

const Magnifier = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4L14 14" />
  </svg>
);

/**
 * The search field with its panel. On a wide screen the field sits in the header. On a narrow one
 * the header shows a magnifier button, and the field opens as a bar across the top.
 *   search  asks the server; rejects when it could not
 *   onPick  the reader chose a result
 */
export function SearchBox({ search, onPick, participants }: Look & {
  search: (q: string, decisionsOnly: boolean) => Promise<Message[]>;
  onPick: (m: Message) => void;
}) {
  const [text, setText] = useState('');
  const [decisionsOnly, setDecisionsOnly] = useState(false);
  const [open, setOpen] = useState(false); // the panel
  const [bar, setBar] = useState(false); // narrow screens: the field is out
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const order = useRef(newestOnly());
  const searchRef = useRef(search);
  searchRef.current = search;

  // Ask the server a moment after the last key. An answer counts only if no newer question was asked since.
  const ask = useRef(debounce((q: string, words: string[], decisions: boolean) => {
    const ticket = order.current.ticket();
    searchRef.current(q, decisions).then(
      (results) => { if (order.current.isNewest(ticket)) { setState({ kind: 'done', results, words }); setActive(results.length ? 0 : -1); } },
      (e: unknown) => { if (order.current.isNewest(ticket)) setState({ kind: 'problem', message: `The search failed: ${e instanceof Error ? e.message : String(e)}` }); },
    );
  }, SEARCH_WAIT_MS));
  useEffect(() => {
    const waiting = ask.current;
    return () => waiting.cancel();
  }, []);

  const change = (nextText: string, nextDecisions: boolean) => {
    setText(nextText);
    setDecisionsOnly(nextDecisions);
    setOpen(true);
    order.current.ticket(); // whatever is still on its way answers an older question
    if (nextText.trim() === '') { ask.current.cancel(); setState({ kind: 'idle' }); setActive(-1); return; }
    const query = parseQuery(nextText);
    if (!query.ok) { ask.current.cancel(); setState({ kind: 'problem', message: queryProblem(query.error) }); setActive(-1); return; }
    // The results of the previous question stay until the new ones are there, so the list doesn't flicker.
    setState((s) => (s.kind === 'done' ? s : { kind: 'searching' }));
    ask.current.call(nextText, query.words, nextDecisions);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (bar) { setBar(false); if (returnFocus) opener.current?.focus(); }
  };
  const pick = (m: Message) => {
    close(false);
    field.current?.blur();
    onPick(m);
  };

  const results = state.kind === 'done' ? state.results : [];
  const activeId = open && active >= 0 && results[active] ? `${listId}-${results[active].id}` : undefined;
  // Keep the result the keyboard is on in view.
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [activeId]);
  // The bar has just come out: the cursor goes into the field.
  useEffect(() => { if (bar) field.current?.focus(); }, [bar]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (open || bar) { e.preventDefault(); close(true); }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault(); // otherwise the cursor jumps to the start or end of the field
      setOpen(true);
      setActive((i) => (e.key === 'ArrowDown' ? Math.min(results.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (e.key === 'Enter' && e.target === field.current) {
      if (open && results[active]) { e.preventDefault(); pick(results[active]); }
    }
  };

  const note = searchNote(state, decisionsOnly);
  return (
    <div
      // On a narrow screen this holds only the magnifier button, and must not shrink under it.
      ref={root} className="flex flex-1 items-center md:min-w-0" onKeyDown={onKeyDown}
      // The focus went somewhere else on the page: the panel closes.
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) close(false); }}
    >
      <button
        ref={opener} type="button" aria-label="Search messages" title="Search messages" aria-expanded={bar}
        onClick={() => { setBar(true); setOpen(true); }}
        className="cursor-pointer rounded-md border border-line bg-transparent p-[7px] text-muted hover:text-fg md:hidden"
      ><Magnifier /></button>
      <div className={`${bar ? 'max-md:flex' : 'max-md:hidden'} min-w-0 items-center gap-2 max-md:fixed max-md:inset-x-0 max-md:top-0 max-md:z-40 max-md:border-b max-md:border-line max-md:bg-bg max-md:px-4 max-md:py-2.5 md:relative md:flex md:w-full md:max-w-[320px]`}>
        <input
          ref={field} type="search" role="combobox" aria-label="Search messages" aria-autocomplete="list"
          aria-expanded={open} aria-controls={results.length ? listId : undefined} aria-activedescendant={activeId}
          placeholder="Search" autoComplete="off" spellCheck={false} maxLength={400}
          value={text} onChange={(e) => change(e.target.value, decisionsOnly)} onFocus={() => setOpen(true)}
          className="w-full min-w-0 rounded-md border border-line bg-panel px-2.5 py-[5px] text-[13px] placeholder:text-muted"
        />
        <button type="button" onClick={() => close(true)} className="cursor-pointer rounded-md border border-line bg-transparent px-2.5 py-[5px] text-[13px] md:hidden">Close</button>
        {open && (
          // A press anywhere in the panel leaves the focus where it is (in the field, as a rule), so
          // the panel doesn't take it for "the reader went elsewhere" and close. The click still counts.
          <div onMouseDown={(e) => e.preventDefault()} className="absolute left-0 top-full z-40 w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-md border border-line bg-panel shadow-lg shadow-black/50 max-md:inset-x-0 max-md:w-auto max-md:rounded-none max-md:border-x-0 md:mt-1.5">
            <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px]">
              <input type="checkbox" checked={decisionsOnly} onChange={(e) => change(text, e.target.checked)} className="accent-decision" />
              Decisions only
            </label>
            {results.length > 0 && (
              <SearchResults listId={listId} results={results} words={state.kind === 'done' ? state.words : []} active={active} onPick={pick} onPoint={setActive} participants={participants} />
            )}
            {/* Said aloud by a screen reader when it changes: how the search stands. */}
            <p role="status" className={`m-0 px-3 text-xs text-muted ${note ? 'border-t border-line py-2' : ''}`}>
              {note || (results.length ? <span className="sr-only">{results.length === 1 ? '1 message found.' : `${results.length} messages found.`}</span> : null)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
