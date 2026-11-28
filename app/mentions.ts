// @names in message text: which ones are participants, so the page can show them in their colours,
// and what the @name at the start of a draft will do, so a typo is caught before Send.
// Only the @name at the start of a message addresses it (see `addressing` in lib/shared.ts);
// later ones are coloured too, as a sign the name is right, but they wake no one.

/** An @ followed by what could be a name. Not inside a word, so mail@example.com is no mention. */
const HANDLE = /(^|[^A-Za-z0-9_@.])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** The participant `typed` names (any case), or null. */
export function participantNamed(typed: string, names: readonly string[]): string | null {
  const lower = typed.toLowerCase();
  return names.find((n) => n.toLowerCase() === lower) ?? null;
}

/** Splits text into plain parts and @mentions of participants. Unknown @names stay plain. */
export function splitMentions(text: string, names: readonly string[]): (string | { name: string; typed: string })[] {
  const parts: (string | { name: string; typed: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(HANDLE)) {
    // "@claude-" or "@claude_x" is not @claude: take the longest participant name the word starts with.
    const word = m[2];
    const name = [...names].sort((a, b) => b.length - a.length).find((n) => {
      const head = word.slice(0, n.length);
      return head.toLowerCase() === n.toLowerCase() && !/[A-Za-z0-9_]/.test(word.charAt(n.length));
    });
    if (!name) continue;
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) parts.push(text.slice(last, at));
    parts.push({ name, typed: text.slice(at, at + 1 + name.length) });
    last = at + 1 + name.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Edit distance, for "did you mean". Names are short, so the simple table is fine. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

export type LeadingHandle =
  | { kind: 'none' }
  | { kind: 'known'; name: string }
  | { kind: 'unknown'; typed: string; suggestion: string | null };

/** What the @name at the start of a draft does: addresses a participant, or names no one (with the nearest name). */
export function leadingHandle(draft: string, names: readonly string[]): LeadingHandle {
  const m = /^\s*@([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(draft);
  if (!m) return { kind: 'none' };
  const first = splitMentions(draft.trimStart(), names)[0];
  if (first && typeof first !== 'string') return { kind: 'known', name: first.name };
  const typed = m[1].toLowerCase();
  let best: string | null = null;
  let bestDistance = 3; // at most two letters off
  for (const n of names) {
    const d = distance(typed, n.toLowerCase());
    if (d < bestDistance) { best = n; bestDistance = d; }
  }
  return { kind: 'unknown', typed: m[1], suggestion: best };
}
