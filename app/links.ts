// Links in message text, made easier to read and to click:
//   - «PR 62», «PR #62» and «pull request 62» become links to that pull request on GitHub, when the
//     hub knows its repository (TRIALOG_REPO, «owner/name», written in at build time). A plain «#62»
//     stays what it is in the chat: message 62. A known name in front, «other-repo PR 36», links
//     that repository instead when it is listed in TRIALOG_REPO_PREFIXES (`name=owner/repo,…`).
//     A bare «PR 36» still uses the hub's repository. A name that is not on the list is left as
//     written, and «PR 36» still uses the hub's repository.
//   - A bare address to a pull request or an issue on GitHub reads «PR 62» or «issue 5». Any other
//     address is shown as written. The full address is in the link's title.
//   - Links to other sites carry a small globe, so it is clear that a click leaves the hub.

/** «owner/name» of a GitHub repository, or null when the value is missing or not that shape. */
export function repoOf(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(v) && !v.endsWith('/.') && !v.includes('..') ? v : null;
}

/** The repository this build links pull requests to (TRIALOG_REPO). */
export const REPO: string | null = repoOf(process.env.TRIALOG_REPO);

export const pullRequestUrl = (repo: string, n: number): string => `https://github.com/${repo}/pull/${n}`;

const PREFIX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parses TRIALOG_REPO_PREFIXES (`name=owner/repo,…`). Each value is checked with `repoOf`; a
 * malformed name, a missing '=', or a value that is not `owner/name` is dropped. The first
 * good entry for a name wins.
 */
export function prefixesOf(value: string | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const repo = repoOf(part.slice(eq + 1));
    if (!PREFIX_NAME.test(name) || !repo || out[name]) continue;
    out[name] = repo;
  }
  return out;
}

/** Short names in front of «PR N» that this build links to other repositories (TRIALOG_REPO_PREFIXES). */
export const REPO_PREFIXES: Readonly<Record<string, string>> = prefixesOf(process.env.TRIALOG_REPO_PREFIXES);

function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The GitHub owner/name for a written prefix, or `fallback` when none was written. */
export function repoForPrefix(
  prefix: string | null | undefined,
  fallback: string | null = REPO,
  prefixes: Readonly<Record<string, string>> = REPO_PREFIXES,
): string | null {
  if (prefix) return prefixes[prefix.toLowerCase()] ?? null;
  return fallback;
}

export interface PullRequestRef { n: number; typed: string; prefix: string | null }

/** One RegExp for a prefix map. Built once for this build's setting; built again only in tests. */
function prRefOf(prefixes: Readonly<Record<string, string>>): RegExp {
  const names = Object.keys(prefixes)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  // Group 3 is the written prefix when the map has names; a never-matching group keeps the indices
  // the same when the setting is empty.
  return new RegExp(`(^|[^A-Za-z0-9_])((?:(${names || '(?!)'}) +)?(?:PR|pull request) ?#?(\\d{1,6}))(?![A-Za-z0-9_])`, 'gi');
}

const PR_REF = prRefOf(REPO_PREFIXES);

/** Splits text into plain parts and references to pull requests. */
export function splitPullRequests(
  text: string,
  prefixes: Readonly<Record<string, string>> = REPO_PREFIXES,
): (string | PullRequestRef)[] {
  const parts: (string | PullRequestRef)[] = [];
  const re = prefixes === REPO_PREFIXES ? PR_REF : prRefOf(prefixes);
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) parts.push(text.slice(last, at));
    parts.push({ n: Number(m[4]), typed: m[2], prefix: m[3] ? m[3].toLowerCase() : null });
    last = at + m[2].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Whether a link leaves the hub: an http(s) address (links within the page start with #). */
export function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** What a bare address shows: «PR 62» / «issue 5» for a pull request or issue on GitHub, else itself. */
export function shortLabel(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { return href; }
  const gh = /^\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol === 'https:' && url.hostname === 'github.com' && gh && !url.search && !url.hash) return `${gh[1] === 'pull' ? 'PR' : 'issue'} ${gh[2]}`;
  return href;
}

/** A pull request address on GitHub: github.com/<owner>/<repo>/pull/<n>. */
const PR_ADDR = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/pull\/(\d{1,6})(?![0-9])/gi;

/** Text without code blocks and code spans, which the page leaves as written (no PR links there). */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * The pull request numbers of this hub a message's text links, in the order they appear. A
 * github.com/…/pull/N address counts only when its owner/name is this hub's repository (or when
 * no hub repository is set). «PR 62» or «hub PR 62» counts when this build has a repository to
 * link to and the name in front, if any, maps to that same repository. A name that maps to
 * another repository, or a bare address of another repository, does not count: Ship it is for
 * this hub's pull requests. Code is not counted.
 */
export function pullRequestNumbers(
  text: string,
  repo: string | null = REPO,
  prefixes: Readonly<Record<string, string>> = REPO_PREFIXES,
): number[] {
  const prose = withoutCode(text);
  const nums: number[] = [];
  const seen = new Set<number>();
  const add = (n: number) => { if (!seen.has(n)) { seen.add(n); nums.push(n); } };
  if (repo !== null) {
    for (const part of splitPullRequests(prose, prefixes)) {
      if (typeof part !== 'string' && sameRepo(repoForPrefix(part.prefix, repo, prefixes), repo)) add(part.n);
    }
  }
  for (const m of prose.matchAll(PR_ADDR)) {
    if (repo === null || sameRepo(m[1], repo)) add(Number(m[2]));
  }
  return nums;
}

/** Whether a message's text links a pull request of this hub, as the page shows it. Same gate as pullRequestNumbers. */
export function linksPullRequest(
  text: string,
  repo: string | null = REPO,
  prefixes: Readonly<Record<string, string>> = REPO_PREFIXES,
): boolean {
  return pullRequestNumbers(text, repo, prefixes).length > 0;
}

/**
 * What the hovercard on a link says: the site, then what the address points at. For GitHub,
 * «github.com · owner/repo · pull request 62»; otherwise the host and the rest of the address.
 */
export function cardText(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { return href; }
  const host = url.hostname.replace(/^www\./, '');
  const gh = /^\/([^/]+)\/([^/]+)(?:\/(pull|issues)\/(\d+))?\/?$/.exec(url.pathname);
  if (host === 'github.com' && gh) {
    const what = gh[3] ? ` · ${gh[3] === 'pull' ? 'pull request' : 'issue'} ${gh[4]}` : '';
    return `github.com · ${gh[1]}/${gh[2]}${what}`;
  }
  const rest = (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash;
  return rest ? `${host} · ${rest.length > 60 ? `${rest.slice(0, 59)}…` : rest}` : host;
}
