// A pull request's summary for the hovercard on «PR 84» links: title, state, author, the first lines
// of its description and whether it has a picture. Read from GitHub's public API for TRIALOG_REPO and
// kept for five minutes. The picture is fetched by the server too (pictureUrl stays here), so the
// reader's browser never contacts GitHub just by hovering: message text loads no outside images.
import { githubHeaders } from './streak';

export const PR_CACHE_MS = 5 * 60_000;
export const PR_SNIPPET_CHARS = 280;
/** Where a PR picture may come from (our own pr-media branch and GitHub's attachments). */
const PICTURE_HOSTS = /^https:\/\/(raw\.githubusercontent\.com|github\.com|user-images\.githubusercontent\.com)\//;

export interface PrSummary {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  author: string;
  snippet: string;
  hasPicture: boolean;
  url: string;
}

/** The first image address in a PR body (Markdown or <img>), if it is from an allowed host. */
export function pictureOf(body: string): string | null {
  const m = /!\[[^\]]*\]\((\S+?)\)|<img[^>]*\ssrc="([^"]+)"/i.exec(body || '');
  const url = m ? (m[1] || m[2]) : null;
  return url && PICTURE_HOSTS.test(url) ? url : null;
}

/** The body as a short plain text: no images, links reduced to their text, no Markdown marks. */
export function snippetOf(body: string, max = PR_SNIPPET_CHARS): string {
  const text = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<img[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function summarize(pr: Record<string, unknown>): { summary: PrSummary; picture: string | null } {
  const body = String(pr.body ?? '');
  const picture = pictureOf(body);
  const state = pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
  return {
    summary: {
      number: Number(pr.number), title: String(pr.title ?? ''), state,
      author: String((pr.user as { login?: unknown } | null)?.login ?? ''),
      snippet: snippetOf(body), hasPicture: Boolean(picture), url: String(pr.html_url ?? ''),
    },
    picture,
  };
}

const cache = new Map<string, { at: number; summary: PrSummary; picture: string | null }>();

export async function prSummary(repo: string, n: number, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<{ summary: PrSummary; picture: string | null } | null> {
  const key = `${repo}#${n}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < PR_CACHE_MS) return hit;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${n}`, { headers: githubHeaders(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const done = { at: now, ...summarize((await res.json()) as Record<string, unknown>) };
  cache.set(key, done);
  return done;
}

export function clearPrCache(): void { cache.clear(); }
