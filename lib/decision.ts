// What makes a message a decision. One rule, used by the Decision badge on the page, by the
// search's "decisions only" filter in the in-memory store, and, written as a Postgres pattern,
// by the same filter in the database. This file has no server code in it.
//
// A decision is a message its writer began with DECISION: (in capitals, after an optional @name).
// Whether a message is pinned plays no part: a note pinned by hand is not a decision, and a
// decision that was unpinned still is one.
import { SENDERS } from './shared';

const NAMES = SENDERS.join('|');
// The same rule the server pins by (lib/core.ts): DECISION: in capitals, after an optional @name.
const STARTS_DECISION = new RegExp(`^\\s*(?:@(?:${NAMES})\\b[\\s,:]*)?DECISION:`);

/**
 * Whether a message is a decision: what its writer wrote starts with DECISION:, by the server's
 * rule. Lines of a quote at the top (starting with ">") and empty lines are skipped first, so a
 * decision that opens with what it answers is still one. A DECISION: inside a quote, or further
 * down in the text, does not make a message a decision.
 */
export function isDecision(text: string): boolean {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trimStart().startsWith('>'));
  return first !== -1 && STARTS_DECISION.test(lines.slice(first).join('\n'));
}

/**
 * The same rule as a Postgres regular expression, for `text ~ $n` (case matters, as above).
 * First any number of lines that are empty or a quote, then the start of a decision.
 * tests/search.test.ts runs a list of texts through both and expects the same answers.
 */
export const DECISION_SQL_PATTERN = `^(?:[[:blank:]\\r\\f\\v]*(?:>[^\\n]*)?\\n)*\\s*(?:@(?:${NAMES})\\y[\\s,:]*)?DECISION:`;
