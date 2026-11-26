// What happens to an uploaded image before anything is stored (PLAN-v2.md, Step 7).
//
//   1. The type is read from the first bytes. A file name or a Content-Type header proves nothing.
//   2. `sharp` decodes the image and turns it the way its EXIF orientation says.
//   3. The pixels are written out again with no metadata: no location, no device, no time.
//
// Only the result of step 3 is ever stored, so the original bytes never reach the database.
//
// One thing is read from the original on the way: its density, which says whether it is a
// screenshot from a high-density screen. That becomes the image's `scale`, a number from 1 to 4
// that only decides how large the page shows it.
import sharp from 'sharp';
import { MAX_ATTACHMENT_BYTES, type ImageType } from './core';
import { scaleFromDensity, validScale } from './shared';

/** Decoded size limit. A small file can unpack into a huge picture; this stops that before it costs memory. */
export const MAX_PIXELS = 40_000_000;

export interface CleanImage {
  data: Buffer;
  content_type: ImageType;
  width: number;
  height: number;
  /** Image pixels per point on the screen it was taken on (lib/shared.ts, Attachment.scale). */
  scale: number;
}
export type ImageResult = ({ ok: true } & CleanImage) | { ok: false; status: number; error: string };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG, JPEG or WebP by magic bytes, or null. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12));
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const FORMAT: Record<ImageType, 'png' | 'jpeg' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
// Lossy formats are written at high quality first. If the result is over the cap (a re-encode can
// come out larger than a heavily compressed original), the next step down is tried.
const QUALITY_STEPS = [90, 80, 70];

/**
 * Checks, turns and re-encodes an upload. Returns clean bytes, or the HTTP error to answer with.
 *
 * `scaleHint` is what the client says about the screen the image was taken on (1 to 3), or null.
 * The scale is taken from the file's own density when it records one that means something; then
 * from the hint; otherwise it is 1.
 */
export async function cleanImage(input: Buffer, scaleHint: number | null = null): Promise<ImageResult> {
  if (input.length === 0) return { ok: false, status: 400, error: 'The request body is empty. Send the image bytes as the body.' };
  if (input.length > MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, error: tooLargeMessage() };
  const type = sniffImageType(input);
  if (!type) return { ok: false, status: 415, error: 'Only PNG, JPEG and WebP images are accepted (recognised by their content, not by name).' };

  const format = FORMAT[type];
  const open = () => sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS, animated: false });
  try {
    // The decoder must agree with the magic bytes; a file that starts like a PNG but isn't one fails here.
    const meta = await open().metadata();
    if (meta.format !== format) return { ok: false, status: 415, error: 'The image content does not match a PNG, JPEG or WebP file.' };
    const scale = scaleFromDensity(meta.density) ?? validScale(scaleHint);

    const encode = (quality: number) => {
      // rotate() with no angle applies the EXIF orientation. Without keepMetadata()/withMetadata(),
      // sharp writes no EXIF, XMP, IPTC or ICC data and converts the colours to sRGB.
      const turned = open().rotate();
      if (format === 'png') return turned.png({ compressionLevel: 9 });
      if (format === 'jpeg') return turned.jpeg({ quality });
      return turned.webp({ quality });
    };
    for (const quality of format === 'png' ? [100] : QUALITY_STEPS) {
      const { data, info } = await encode(quality).toBuffer({ resolveWithObject: true });
      if (data.length <= MAX_ATTACHMENT_BYTES) {
        return { ok: true, data, content_type: type, width: info.width, height: info.height, scale };
      }
    }
    return { ok: false, status: 413, error: `${tooLargeMessage()} (It grew past the limit when it was re-encoded; make it smaller.)` };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (/pixel limit/i.test(reason)) {
      return { ok: false, status: 413, error: `The image has more than ${MAX_PIXELS / 1_000_000} million pixels. Make it smaller.` };
    }
    return { ok: false, status: 400, error: 'The image could not be read. It may be damaged.' };
  }
}

export const tooLargeMessage = (): string => `The image is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
