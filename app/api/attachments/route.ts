import { MAX_ATTACHMENT_BYTES, UPLOADS_PER_HOUR } from '../../../lib/core';
import { authenticate, error, json, readBytes, safe } from '../../../lib/http';
import { cleanImage, tooLargeMessage } from '../../../lib/images';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// POST /api/attachments, with the raw image bytes as the body.
// PNG, JPEG or WebP, at most 4 MB, recognised by content (the Content-Type header is not trusted).
// The image is turned upright and re-encoded without metadata before anything is stored.
// Answers 201 {"id": "att_…", "content_type", "width", "height", "bytes"}. Link it to a message
// with POST /api/messages {"attachments": ["att_…"]} within the hour, or it is deleted.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [raw, tooLarge] = await readBytes(request, MAX_ATTACHMENT_BYTES, tooLargeMessage());
  if (tooLarge) return tooLarge;
  const image = await cleanImage(raw);
  if (!image.ok) return error(image.status, image.error);
  const store = await getStore();
  const attachment = await store.addAttachment({ sender: me, content_type: image.content_type, width: image.width, height: image.height, data: image.data });
  if (!attachment) {
    return error(429, `Rate limit: at most ${UPLOADS_PER_HOUR} image uploads per hour per sender.`, { 'Retry-After': '600' });
  }
  return json(attachment, 201);
});
