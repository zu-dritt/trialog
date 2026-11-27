// Links in message text, made easier to read and to click:
//   - «PR 62», «PR #62» and «pull request 62» become links to that pull request on GitHub, when the
//     hub knows its repository (TRIALOG_REPO, «owner/name», written in at build time). A plain «#62»
//     stays what it is in the chat: message 62.
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

/** «PR 62», «PR #62», «PR#62», «pull request 62», any case; not inside a word. */
const PR_REF = /(^|[^A-Za-z0-9_])((?:PR|pull request) ?#?(\d{1,6}))(?![A-Za-z0-9_])/gi;

/** Splits text into plain parts and references to pull requests. */
export function splitPullRequests(text: string): (string | { n: number; typed: string })[] {
  const parts: (string | { n: number; typed: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(PR_REF)) {
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) parts.push(text.slice(last, at));
    parts.push({ n: Number(m[3]), typed: m[2] });
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
 * Whether a message's text links a pull request, as the page shows it: a github.com/…/pull/N
 * address, or «PR 62» / «PR #62» / «pull request 62» when this build has a repository to link to.
 * Code is not counted. This is what puts the «🚀 Ship it!» button on a message.
 */
export function linksPullRequest(text: string, repo: string | null = REPO): boolean {
  const prose = withoutCode(text);
  if (PR_URL.test(prose)) return true;
  return repo !== null && splitPullRequests(prose).some((part) => typeof part !== 'string');
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
