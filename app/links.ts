// Links in message text, made easier to read and to click:
//   - «PR 62», «PR #62» and «pull request 62» become links to that pull request on GitHub, when the
//     hub knows its repository (TRIALOG_REPO, «owner/name», written in at build time). A plain «#62»
//     stays what it is in the chat: message 62. A known repo name in front, «apartment-finder PR 36»,
//     links that repository instead (REPO_PREFIXES); «trialog PR 36» links zu-dritt/trialog. A bare
//     «PR 36» still uses the hub's repository.
//   - A bare address to a pull request or an issue on GitHub reads «PR 62» or «issue 5». Any other
//     address is shown as written. The full address is in the link's title.
//   - Links to other sites carry a small globe, so it is clear that a click leaves the hub.

/** «owner/name» of the hub's repository, or null when the setting is missing or not that shape. */
export function repoOf(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(v) && !v.endsWith('/.') && !v.includes('..') ? v : null;
}

/** The repository this build links pull requests to (TRIALOG_REPO). */
export const REPO: string | null = repoOf(process.env.TRIALOG_REPO);

export const pullRequestUrl = (repo: string, n: number): string => `https://github.com/${repo}/pull/${n}`;

/**
 * A short name written in front of «PR N» that names a known repository. The default for a bare
 * «PR 36» stays the hub's own repository (TRIALOG_REPO), usually zu-dritt/trialog.
 */
export const REPO_PREFIXES: Readonly<Record<string, string>> = {
  'apartment-finder': 'amberleaf-gmbh/apartment-finder',
  'trialog': 'zu-dritt/trialog',
};

/** The GitHub owner/name for a written prefix, or `fallback` when none was written. */
export function repoForPrefix(prefix: string | null | undefined, fallback: string | null = REPO): string | null {
  if (prefix) return REPO_PREFIXES[prefix.toLowerCase()] ?? null;
  return fallback;
}

export interface PullRequestRef { n: number; typed: string; prefix: string | null }

/** «apartment-finder PR 36», «PR 62», «PR #62», «pull request 62», any case; not inside a word. */
function prRef(): RegExp {
  const names = Object.keys(REPO_PREFIXES)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  return new RegExp(`(^|[^A-Za-z0-9_])((?:(${names}) +)?(?:PR|pull request) ?#?(\\d{1,6}))(?![A-Za-z0-9_])`, 'gi');
}

/** Splits text into plain parts and references to pull requests. */
export function splitPullRequests(text: string): (string | PullRequestRef)[] {
  const parts: (string | PullRequestRef)[] = [];
  let last = 0;
  for (const m of text.matchAll(prRef())) {
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
const PR_URL = /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,6}(?![0-9])/i;

/** Text without code blocks and code spans, which the page leaves as written (no PR links there). */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Whether a message's text links a pull request of this hub's repository, as the page shows it: a
 * github.com/…/pull/N address, or «PR 62» / «trialog PR 62» when this build has a repository to
 * link to. «apartment-finder PR 36» links that other repo and does not count here: Ship it is for
 * this hub's pull requests. Code is not counted.
 */
export function linksPullRequest(text: string, repo: string | null = REPO): boolean {
  const prose = withoutCode(text);
  if (PR_URL.test(prose)) return true;
  return repo !== null && splitPullRequests(prose).some((part) => typeof part !== 'string' && repoForPrefix(part.prefix, repo) === repo);
}

/** The pull request numbers a message's text links, in the order they appear. Same gate as linksPullRequest. */
export function pullRequestNumbers(text: string, repo: string | null = REPO): number[] {
  const prose = withoutCode(text);
  const nums: number[] = [];
  const seen = new Set<number>();
  const add = (n: number) => { if (!seen.has(n)) { seen.add(n); nums.push(n); } };
  if (repo !== null) {
    for (const part of splitPullRequests(prose)) {
      if (typeof part !== 'string' && repoForPrefix(part.prefix, repo) === repo) add(part.n);
    }
  }
  for (const m of prose.matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/(\d{1,6})(?![0-9])/gi)) {
    add(Number(m[1]));
  }
  return nums;
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
