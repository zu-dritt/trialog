import { MAX_ATTACHMENT_BYTES, UPLOADS_PER_HOUR } from '../../../lib/core';
import { authenticate, error, json, readBytes, safe } from '../../../lib/http';
import { cleanImage, sniffImageType, tooLargeMessage } from '../../../lib/images';
import { SCALE_HINT_HEADER, parseScaleHint } from '../../../lib/shared';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// POST /api/attachments, with the raw image bytes as the body.
// PNG, JPEG or WebP, at most 4 MB, recognised by content (the Content-Type header is not trusted).
// The image is turned upright and re-encoded without metadata before anything is stored.
// Answers 201 {"id": "att_…", "content_type", "width", "height", "bytes", "scale"}. Link it to a message
// with POST /api/messages {"attachments": ["att_…"]} within the hour, or it is deleted.
// Optional header X-Image-Scale: 1, 2 or 3, for a screenshot whose file no longer says which
// screen it came from. It only affects how large the page shows the image; anything else in the
// header is ignored.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [raw, tooLarge] = await readBytes(request, MAX_ATTACHMENT_BYTES, tooLargeMessage());
  if (tooLarge) return tooLarge;
  const overLimit = () => error(429, `Rate limit: at most ${UPLOADS_PER_HOUR} image uploads per hour per sender.`, { 'Retry-After': '600' });
  const store = await getStore();
  // Decoding is the expensive step, so a sender who is already over the hourly limit is refused
  // before it: after the size cap and the look at the first bytes, which cost nothing. A body that
  // is not an image at all skips this and gets its own answer from cleanImage, which doesn't
  // decode it either.
  if (sniffImageType(raw) && (await store.uploadsInLastHour(me)) >= UPLOADS_PER_HOUR) return overLimit();
  const image = await cleanImage(raw, parseScaleHint(request.headers.get(SCALE_HINT_HEADER)));
  if (!image.ok) return error(image.status, image.error);
  // The count that decides is taken again here, under a lock, together with the insert.
  const attachment = await store.addAttachment({ sender: me, content_type: image.content_type, width: image.width, height: image.height, data: image.data, scale: image.scale });
  if (!attachment) return overLimit();
  return json(attachment, 201);
});
