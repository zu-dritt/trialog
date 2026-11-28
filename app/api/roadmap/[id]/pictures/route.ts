import { authenticate, error, json, readJson, safe } from '../../../../../lib/http';
import { ROADMAP_ID, parsePictures } from '../../../../../lib/roadmap';
import { AttachmentLinkError, getStore } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/roadmap/<id>/pictures {"attachments": ["att_…", …]} → {item}: the card's pictures, in
// this order (playground #1403). Pictures already on the card stay; new ones are the caller's own
// uploads (POST /api/attachments) that belong to nothing yet; pictures left out are deleted.
export const PUT = safe(async (request: Request, ctx: Ctx) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!ROADMAP_ID.test(id)) return error(404, 'No such card.');
  const [body, bad] = await readJson(request, 2 * 1024);
  if (bad) return bad;
  const input = parsePictures(body);
  if (!input.ok) return error(input.status, input.error);
  try {
    const item = await (await getStore()).setRoadmapPictures(id, input.attachments, me);
    return item ? json({ item }) : error(404, 'No such card.');
  } catch (e) {
    if (e instanceof AttachmentLinkError) return error(e.reason === 'already linked' ? 409 : e.reason === 'not yours' ? 403 : 404, e.message);
    throw e;
  }
});
