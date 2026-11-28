// «Retro-Karte nach jedem Release»: after a release, one card on the roadmap to look back. A release
// is a pull request merged into TRIALOG_RETRO_BASE (default «test»: agents bring playground there,
// CONTRIBUTING.md). The card says what shipped (the playground PRs merged since the release
// before), how many, the streak at that moment, and what went wrong as far as the hub knows it: the
// streak's breaks, each with its honest reason. Below that are three empty lines for the people to
// fill in, in the edit window. It needs no new table: the release is found again by the note
// «retro of release PR #N», so asking twice returns the same card. Nothing here merges or deploys.
import { ROADMAP_DESCRIPTION_MAX, ROADMAP_NOTE_MAX, ROADMAP_TITLE_MAX } from './roadmap';
import { computeStreak, type Merge, type StreakBreak } from './streak';

export const RETRO_TZ = 'Europe/Zurich';
/** How many shipped PRs the card lists; the count always covers all of them. */
export const RETRO_LIST_MAX = 40;
/** How many streak breaks the card lists. */
export const RETRO_BREAKS_MAX = 10;

/** The branch whose merges are releases. */
export function retroBase(env: Record<string, string | undefined> = process.env): string {
  const v = env.TRIALOG_RETRO_BASE?.trim();
  return v && /^[A-Za-z0-9._/-]{1,100}$/.test(v) ? v : 'test';
}

/** The note that finds a release's card again. */
export const retroNote = (release: number): string => `retro of release PR #${release}`;
const NOTE = /^retro of release PR #(\d+)$/;

/** The release a card is the retro of, or null. */
export function retroReleaseOf(note: string): number | null {
  const m = NOTE.exec(note.trim());
  return m ? Number(m[1]) : null;
}

export interface Retro { release: number; title: string; note: string; description: string; shipped: number; breaks: number }

const when = (at: string | number): string => new Intl.DateTimeFormat('en-GB', { timeZone: RETRO_TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
const cut = (s: string, max: number): string => { const c = [...s]; return c.length > max ? `${c.slice(0, max - 1).join('').trimEnd()}…` : s; };

/** The release to look back on: `wanted` when given, else the latest merged one. */
export function pickRelease(releases: readonly Merge[], wanted?: number): Merge | null {
  const sorted = [...releases].filter((r) => Number.isFinite(Date.parse(r.merged_at))).sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.number - b.number);
  if (wanted !== undefined) return sorted.find((r) => r.number === wanted) ?? null;
  return sorted.at(-1) ?? null;
}

/**
 * The card for `release`. `releases` are all merges into the release branch, `merges` the playground
 * merges (what the streak counts), `breaks` the streak's breaks. What shipped is every merge after
 * the release before this one, up to and including this one; with no earlier release, everything so far.
 */
export function buildRetro(release: Merge, releases: readonly Merge[], merges: readonly Merge[], breaks: readonly StreakBreak[]): Retro {
  const end = Date.parse(release.merged_at);
  const before = releases.filter((r) => Date.parse(r.merged_at) < end || (Date.parse(r.merged_at) === end && r.number < release.number));
  const start = before.length ? Math.max(...before.map((r) => Date.parse(r.merged_at))) : -Infinity;
  const shipped = merges.filter((m) => { const t = Date.parse(m.merged_at); return Number.isFinite(t) && t > start && t <= end; }).sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.number - b.number);
  const wrong = breaks.filter((b) => { const t = Date.parse(b.created_at); return Number.isFinite(t) && t > start && t <= end; }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const streak = computeStreak(merges.filter((m) => Date.parse(m.merged_at) <= end), breaks.filter((b) => Date.parse(b.created_at) <= end));

  const total = `${shipped.length} ${shipped.length === 1 ? 'PR' : 'PRs'}`;
  const head = [
    `Release PR #${release.number} «${oneLine(release.title)}», merged ${when(end)} (Zurich).`,
    start === -Infinity ? 'Since the start.' : `Since the release before it, ${when(start)}.`,
    '',
    `What shipped: ${total}`,
  ];
  const tail = ['', `Streak at the release: ${streak.current} in a row (record ${streak.record}).`, '', 'What went wrong, as the hub knows it (the streak was ended):'];
  if (wrong.length) {
    for (const b of wrong.slice(0, RETRO_BREAKS_MAX)) tail.push(`- ${when(b.created_at)} ${b.participant}: ${cut(oneLine(b.reason), 200)}`);
    if (wrong.length > RETRO_BREAKS_MAX) tail.push(`- … and ${wrong.length - RETRO_BREAKS_MAX} more`);
  } else tail.push('- Nothing: the orchestrator did not have to step in.');
  tail.push('', 'What went well, in your words:', '', 'What went wrong, in your words:', '', 'What we change next time:');
  // The people's three lines at the end must never be cut: the list of PRs gets what room is left.
  const fixed = [...head, ...tail].join('\n');
  let room = ROADMAP_DESCRIPTION_MAX - [...fixed].length - 1 - [...`- … and ${shipped.length} more`].length - 1;
  const list: string[] = [];
  for (const m of shipped.slice(0, RETRO_LIST_MAX)) {
    const line = `- #${m.number} ${cut(oneLine(m.title), 90)}`;
    const cost = [...line].length + 1;
    if (cost > room) break;
    list.push(line);
    room -= cost;
  }
  if (list.length < shipped.length) list.push(`- … and ${shipped.length - list.length} more`);
  const description = [...head, ...list, ...tail].join('\n');
  const title = cut(`Retro: release #${release.number}, ${total}`, ROADMAP_TITLE_MAX);
  const note = retroNote(release.number);
  if ([...note].length > ROADMAP_NOTE_MAX) throw new Error('retro note too long');
  return { release: release.number, title, note, description, shipped: shipped.length, breaks: wrong.length };
}
