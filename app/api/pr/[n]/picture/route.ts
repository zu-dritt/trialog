import { authenticate, error, safe } from '../../../../../lib/http';
import { prSummary } from '../../../../../lib/pr-summary';
import { repoOf } from '../../../../links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 4 * 1024 * 1024;

// GET /api/pr/<n>/picture → the first picture of the PR's description, fetched by the hub, so the
// reader's browser never contacts GitHub by hovering. PNG, JPEG, GIF or WebP, at most 4 MB.
export const GET = safe(async (request: Request, { params }: { params: Promise<{ n: string }> }) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const repo = repoOf(process.env.TRIALOG_REPO);
  const { n } = await params;
  if (!repo || !/^\d{1,6}$/.test(n)) return error(404, 'No such pull request.');
  const found = await prSummary(repo, Number(n)).catch(() => null);
  if (!found?.picture) return error(404, 'This pull request has no picture.');
  const res = await fetch(found.picture, { redirect: 'follow' });
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return error(502, 'The picture could not be read.');
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return error(502, 'The picture is too large.');
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
});
