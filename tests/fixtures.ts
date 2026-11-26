// Test images, built in code. No real photos: every pixel and every metadata value here is made up.
import sharp from 'sharp';

/** A camera name and a GPS date that are easy to find in raw bytes. */
export const FAKE_CAMERA = 'TrialogTestCam';
export const FAKE_GPS_DATE = '2031:02:03';

/** Raw RGB pixels: the left half red, the right half blue. */
function redLeftBlueRight(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw[(y * width + x) * 3 + (x < width / 2 ? 0 : 2)] = 255;
  }
  return raw;
}

export function picture(width = 40, height = 20) {
  return sharp(redLeftBlueRight(width, height), { raw: { width, height, channels: 3 } });
}

export const png = (width = 40, height = 20): Promise<Buffer> => picture(width, height).png().toBuffer();
export const webp = (width = 40, height = 20): Promise<Buffer> => picture(width, height).webp({ lossless: true }).toBuffer();
export const jpeg = (width = 40, height = 20): Promise<Buffer> => picture(width, height).jpeg({ quality: 95 }).toBuffer();

/**
 * A 40×20 JPEG the way a phone writes it: stored lying on its side with "turn me 90° clockwise"
 * (EXIF orientation 6), plus a camera name and a GPS position.
 */
export function phoneJpeg(): Promise<Buffer> {
  return picture(40, 20)
    .withExif({
      IFD0: { Make: FAKE_CAMERA, Model: 'Fixture 1' },
      IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '1/1 2/1 300/100',
        GPSLongitudeRef: 'E', GPSLongitude: '4/1 5/1 600/100',
        GPSDateStamp: FAKE_GPS_DATE,
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** A PNG of random noise, which hardly compresses: about width × height × 3 bytes. */
export function noisePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  // A small fixed generator instead of Math.random, so the file is the same on every run.
  let seed = 123456789;
  for (let i = 0; i < raw.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw[i] = seed >>> 24;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

/** The colour of one pixel of an encoded image, as [r, g, b]. */
export async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + 3)];
}
