import { ATTACHMENT_ID } from '../../../../lib/core';
import { authenticate, error, safe } from '../../../../lib/http';
import { getStore } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// GET /api/attachments/<id> → the image bytes. Bearer token required, like every other endpoint;
// there is no public address for an image. Until a message or a roadmap card links an upload, only its uploader can read it.
export const GET = safe(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const { id } = await params;
  const notFound = () => error(404, 'No such attachment.');
  if (!ATTACHMENT_ID.test(id)) return notFound();
  const found = await (await getStore()).getAttachment(id);
  // Linked to a message or a roadmap card: anyone signed in. Not yet linked: only its uploader.
  if (!found || (found.attachment.message_id === null && !found.attachment.roadmap_item_id && found.attachment.sender !== me)) return notFound();
  const { attachment, data } = found;
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': attachment.content_type,
      'Content-Length': String(data.length),
      'Content-Disposition': `inline; filename="${attachment.id}.${EXTENSION[attachment.content_type]}"`,
      // An attachment never changes, so the reader's own browser may keep it. `private` keeps it out
      // of shared caches, and the request can't be made without the token in the first place.
      'Cache-Control': 'private, max-age=31536000, immutable',
      Vary: 'Authorization',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
