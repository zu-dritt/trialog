'use client';

// The hovercard on a «PR 84» link (playground #603): the pull request's title, state, author, the
// first lines of its description and its picture, from GET /api/pr/<n> (loaded on first hover, then
// kept for the page's life). The picture comes through the hub, never straight from GitHub.
import { useRef, useState, type ReactNode } from 'react';
import type { PrSummary } from '../lib/pr-summary';
import { REPO, pullRequestUrl } from './links';

const TOKEN_KEY = 'collabHubToken';
const loaded = new Map<number, Promise<{ summary: PrSummary; picture: string | null } | null>>();
const resolved = new Map<number, PrSummary | null>();

/** The summary if it has already been loaded on this page, else undefined. */
export function peekedPr(n: number): PrSummary | null | undefined {
  return resolved.has(n) ? resolved.get(n) : undefined;
}

/** Loads the pull request's summary (the same cache the hovercard uses). */
export function loadPr(n: number): Promise<PrSummary | null> {
  return load(n).then((c) => c?.summary ?? null);
}

/** The PR number when `href` is a pull request of this hub's repository, else null. */
export function prNumberOf(href: string, repo: string | null = REPO): number | null {
  if (!repo) return null;
  const m = /\/pull\/(\d{1,6})$/.exec(href);
  return m && href === pullRequestUrl(repo, Number(m[1])) ? Number(m[1]) : null;
}

const STATE: Record<PrSummary['state'], { text: string; color: string }> = {
  open: { text: 'Open', color: '#3fb950' },
  merged: { text: 'Merged', color: '#a371f7' },
  closed: { text: 'Closed', color: '#f85149' },
};

function load(n: number) {
  if (!loaded.has(n)) {
    const token = typeof localStorage === 'undefined' ? '' : localStorage.getItem(TOKEN_KEY) || '';
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    loaded.set(n, fetch(`/api/pr/${n}`, auth).then(async (r) => {
      if (!r.ok) { resolved.set(n, null); return null; }
      const { summary } = (await r.json()) as { summary: PrSummary };
      resolved.set(n, summary);
      let picture: string | null = null;
      if (summary.hasPicture) {
        const p = await fetch(`/api/pr/${n}/picture`, auth).catch(() => null);
        if (p?.ok) picture = URL.createObjectURL(await p.blob());
      }
      return { summary, picture };
    }).catch(() => null));
  }
  return loaded.get(n)!;
}

/** What the card shows, as a plain view (tested without a browser). */
export function PrCardView({ summary, picture }: { summary: PrSummary; picture: string | null }) {
  const s = STATE[summary.state];
  return (
    <span role="tooltip" className="pr-card" data-pr-card={summary.number}>
      <span className="block text-[11px] text-muted">zu-dritt · PR {summary.number} · {summary.author}</span>
      <span className="mt-0.5 block font-semibold text-fg">{summary.title}</span>
      <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: s.color }}>{s.text}</span>
      {picture && <img src={picture} alt="" className="mt-2 block max-h-40 w-full rounded object-cover object-top" />}
      {summary.snippet && <span className="mt-1.5 block text-[12px] leading-snug text-muted">{summary.snippet}</span>}
    </span>
  );
}

/** A PR link with its hovercard: loaded after a short pause on hover or on keyboard focus. */
export function PrLink({ n, children, linkProps }: { n: number; children: ReactNode; linkProps: Record<string, unknown> }) {
  const [card, setCard] = useState<{ summary: PrSummary; picture: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setOpen(true); void load(n).then((c) => c && setCard(c)); }, 250);
  };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };
  return (
    <span className="relative inline" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <a {...linkProps}>{children}</a>
      {open && card && <PrCardView summary={card.summary} picture={card.picture} />}
    </span>
  );
}
