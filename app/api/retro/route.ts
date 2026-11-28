import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { buildRetro, pickRelease, retroBase, retroReleaseOf, type Retro } from '../../../lib/retro';
import { getStore, type Store } from '../../../lib/store';
import { cachedMerges, streakBase } from '../../../lib/streak';
import { repoOf } from '../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET  /api/retro[?release=148] → the retro card for the latest release (or that release PR): {retro, card}.
// POST /api/retro {"release"?: 148} → the same, and the card is added to «Later» if it is not there yet.
// A release is a PR merged into TRIALOG_RETRO_BASE (default «test»); lib/retro.ts says what goes on the card.
// It needs TRIALOG_REPO. Asking twice returns the same card (found by its note), so it is safe to call after every release.
async function plan(wanted: number | undefined): Promise<{ fail: Response } | { retro: Retro; store: Store }> {
  const repo = repoOf(process.env.TRIALOG_REPO);
  if (!repo) return { fail: error(409, 'No repository is set (TRIALOG_REPO), so releases cannot be read.') };
  const [releases, merges] = await Promise.all([cachedMerges(repo, retroBase()), cachedMerges(repo, streakBase())]);
  if (releases.problem && !releases.merges.length) return { fail: error(502, `Releases could not be read from GitHub: ${releases.problem}`) };
  const release = pickRelease(releases.merges, wanted);
  if (!release) return { fail: error(404, wanted === undefined ? `No pull request has been merged into «${retroBase()}» yet.` : `PR #${wanted} was not merged into «${retroBase()}».`) };
  const store = await getStore();
  return { retro: buildRetro(release, releases.merges, merges.merges, await store.listStreakBreaks()), store };
}

const releaseParam = (v: unknown): number | undefined | null => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v)) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const wanted = releaseParam(new URL(request.url).searchParams.get('release'));
  if (wanted === null) return error(400, '"release" must be a pull request number.');
  const p = await plan(wanted);
  if ('fail' in p) return p.fail;
  const card = (await p.store.listRoadmap()).find((i) => retroReleaseOf(i.note) === p.retro.release) ?? null;
  return json({ retro: p.retro, card });
});

export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const text = Number(request.headers.get('content-length') || 0) > 1024 ? 'oversized' : await request.clone().text();
  let wanted: number | undefined;
  if (text.trim()) {
    const [body, bad] = await readJson(request, 1024);
    if (bad) return bad;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'Body must be {"release"?: <pull request number>}.');
    const n = releaseParam((body as { release?: unknown }).release);
    if (n === null) return error(400, 'Body must be {"release"?: <pull request number>}.');
    wanted = n;
  }
  const p = await plan(wanted);
  if ('fail' in p) return p.fail;
  const { retro } = p;
  const made = await p.store.addRoadmapItemOnce({
    column: 'later', title: retro.title, note: retro.note, owner: null, by: me, description: retro.description, top: true,
    sameAs: (item) => retroReleaseOf(item.note) === retro.release,
  });
  if (!made) return error(409, 'The roadmap is full (200 cards). Remove some done cards first.');
  return json({ retro, card: made.item, created: made.created }, made.created ? 201 : 200);
});
