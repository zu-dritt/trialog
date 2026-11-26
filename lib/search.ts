// Search: what a query is, what it matches and how a match is shown. This file has no server
// code in it, so the page uses the same rules as the API and the in-memory store.
//
// A query is a few words. A message matches when its text contains every one of them, in any
// order, upper or lower case. The words are taken literally: nothing in a query is a pattern.
// A poll's question and options count as text of the message that carries the poll.

/** A query longer than this is refused. */
export const MAX_SEARCH_CHARS = 200;
/** A query with more words than this is refused. */
export const MAX_SEARCH_WORDS = 8;
/** How many results a search returns when no limit is given. */
export const SEARCH_LIMIT = 50;

export type ParsedQuery = { ok: true; words: string[] } | { ok: false; error: string };

/** The words of a query, or why it is not one. A word given twice counts once. */
export function parseQuery(q: unknown): ParsedQuery {
  if (typeof q !== 'string' || q.trim() === '') return { ok: false, error: '"q" must contain at least one word.' };
  if (q.length > MAX_SEARCH_CHARS) return { ok: false, error: `"q" can be at most ${MAX_SEARCH_CHARS} characters long.` };
  const words: string[] = [];
  for (const word of q.trim().split(/\s+/)) {
    if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
  }
  if (words.length > MAX_SEARCH_WORDS) return { ok: false, error: `"q" can have at most ${MAX_SEARCH_WORDS} words.` };
  return { ok: true, words };
}

/**
 * A word as a pattern for SQL's LIKE that matches the word anywhere and nothing else: the three
 * characters that mean something to LIKE (% _ and the escape character \) are escaped.
 */
export const likePattern = (word: string): string => `%${word.replace(/[\\%_]/g, '\\$&')}%`;

/** What this file needs to know about a message. */
export interface Searchable {
  text: string;
  poll?: { question: string; options: { text: string }[] } | null;
}

/** Everything in a message that a search looks at, one piece per line. */
export function searchLines(m: Searchable): string[] {
  const lines = m.text.split('\n');
  if (m.poll) {
    // A poll's message text is its question; don't list it twice.
    if (m.text !== m.poll.question) lines.push(m.poll.question);
    for (const option of m.poll.options) lines.push(option.text);
  }
  return lines;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Finds a word anywhere, in upper or lower case, as the characters it is. */
const finder = (word: string, flags = 'i'): RegExp => new RegExp(escapeRegExp(word), flags);

/** Whether a message contains every word. (The in-memory store's search; the database does the same with ILIKE.) */
export function matchesAll(m: Searchable, words: string[]): boolean {
  const text = searchLines(m).join('\n');
  return words.every((word) => finder(word).test(text));
}

export interface Piece {
  text: string;
  /** This piece is a match. */
  hit: boolean;
}

/** A line cut into pieces, so that the matching words can be marked. Always plain text. */
export function markMatches(line: string, words: string[]): Piece[] {
  const usable = words.filter((w) => w !== '');
  if (!usable.length || line === '') return line === '' ? [] : [{ text: line, hit: false }];
  // The longest word first, so "decision" wins over "dec" where both start at the same place.
  const any = new RegExp([...usable].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'gi');
  const pieces: Piece[] = [];
  let done = 0;
  for (const match of line.matchAll(any)) {
    if (match.index > done) pieces.push({ text: line.slice(done, match.index), hit: false });
    pieces.push({ text: match[0], hit: true });
    done = match.index + match[0].length;
  }
  if (done < line.length) pieces.push({ text: line.slice(done), hit: false });
  return pieces;
}

/**
 * One line of a message to show in a list of results: the line with the most of the words in it
 * (the first such line). When words are still missing, the lines that have them follow, joined
 * by " · ", so every word of the query can be seen. A long line is cut around its first match.
 */
export function matchLine(m: Searchable, words: string[], max = 140): string {
  const lines = searchLines(m).map((line) => line.trim()).filter((line) => line !== '');
  const chosen: string[] = [];
  let missing = [...words];
  // At most three lines: enough for a question and two options, and it stays one row on the screen.
  while (chosen.length < 3) {
    let best = '';
    let bestCount = 0;
    for (const line of lines) {
      const count = chosen.includes(line) ? 0 : missing.filter((word) => finder(word).test(line)).length;
      if (count > bestCount) { best = line; bestCount = count; }
    }
    if (!bestCount) break;
    chosen.push(best);
    missing = missing.filter((word) => !finder(word).test(best));
  }
  const text = chosen.length ? chosen.join(' · ') : lines[0] ?? '';
  if (text.length <= max) return text;
  const first = Math.min(...words.map((word) => text.search(finder(word))).filter((at) => at >= 0), text.length);
  // Start a little before the match, so it has some context.
  const start = first === text.length || first < max - 30 ? 0 : Math.max(0, first - 30);
  const room = max - (start ? 2 : 1);
  return `${start ? '…' : ''}${text.slice(start, start + room).trimEnd()}${start + room < text.length ? '…' : ''}`;
}

/**
 * Calls `run` once, `ms` after the last call, with that last call's arguments. `cancel` drops a
 * call that is still waiting.
 */
export function debounce<A extends unknown[]>(run: (...args: A) => void, ms: number): { call: (...args: A) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call: (...args: A) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; run(...args); }, ms);
    },
    cancel: () => { clearTimeout(timer); timer = undefined; },
  };
}

/**
 * Keeps answers in order. Each question takes a ticket; an answer counts only while its ticket
 * is the newest one. So a slow answer to an old question never replaces the answer to a newer one.
 */
export function newestOnly(): { ticket: () => number; isNewest: (ticket: number) => boolean } {
  let newest = 0;
  return { ticket: () => ++newest, isNewest: (ticket) => ticket === newest };
}
