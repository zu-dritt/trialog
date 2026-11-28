'use client';

// Images on the page: the thumbnails in the stream, the full-size view, the preview chips in the
// composer, and shrinking an image that is too large before it is uploaded.
//
// An image is never shown larger than its own size: its pixels divided by its scale (ownSize in
// lib/shared.ts). A screenshot from a high-density screen has two or three pixels for every point
// it covered there, so drawing each of them as a point would blow it up. Only "real size" in the
// full-size view shows every pixel, because the reader asked for it.
//
// An image is only ever served with the Bearer token (GET /api/attachments/<id>), and an
// <img src="…"> can't send that header. So the page fetches the bytes itself and shows them from
// a blob: URL, which lives in this tab only. No <img> here ever points at the API.
import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  DOWNSIZE_LONG_EDGE, IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_SCALE_HINT, SCALE_HINT_HEADER,
  downsizePlan, fitWithin, ownSize, pngDensity, scaleFromDensity, validScale, type Attachment,
} from '../lib/shared';
import { Chip } from './chips';
import { imageNav, imageStep, lightboxKey, swipeStep } from '../lib/image-nav';

export const ACCEPT = IMAGE_TYPES.join(',');
const THUMB_MAX = { width: 320, height: 240 };
const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type LoadImage = (id: string) => Promise<string>;

/**
 * Fetches the bytes of one attachment with the token. A 401 means the token has stopped working:
 * `onUnauthorized` is told, so the page can go back to the token prompt, the same way it does when
 * a message request is refused.
 */
export async function fetchImage(id: string, token: string | null, onUnauthorized: () => void, fetcher: typeof fetch = fetch): Promise<Blob> {
  const res = await fetcher(`/api/attachments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Returns a function that fetches an attachment with the token and gives back a blob: URL.
 * Each image is fetched once per token; the URLs are released when the token changes or the page closes.
 */
export function useImageLoader(token: string | null, onUnauthorized: () => void): LoadImage {
  const cache = useRef(new Map<string, Promise<string>>());
  useEffect(() => {
    const map = cache.current;
    return () => {
      for (const pending of map.values()) pending.then((url) => URL.revokeObjectURL(url), () => {});
      map.clear();
    };
  }, [token]);
  return useCallback((id: string) => {
    const map = cache.current;
    let pending = map.get(id);
    if (!pending) {
      pending = fetchImage(id, token, onUnauthorized).then((blob) => URL.createObjectURL(blob));
      pending.catch(() => { if (map.get(id) === pending) map.delete(id); }); // a failure is not remembered
      map.set(id, pending);
    }
    return pending;
  }, [token, onUnauthorized]);
}

const sizeLabel = (a: Attachment) => `${a.width}×${a.height}`;

/**
 * The box of a thumbnail, in CSS pixels: the image's own size, made smaller if it doesn't fit the
 * largest thumbnail. Never larger than the image's own size.
 */
export function thumbSize(a: Attachment): { width: number; height: number } {
  const own = ownSize(a);
  const box = fitWithin(own.width, own.height, THUMB_MAX.width, THUMB_MAX.height);
  return { width: Math.min(box.width, own.width), height: Math.min(box.height, own.height) };
}

/**
 * The limits of the image in the full-size view while it fits the window: the window, and the
 * image's own size, whichever is smaller. Width and height stay automatic, so the shape is kept.
 */
export function fitLimits(a: { width: number; height: number; scale?: unknown }): { maxWidth: string; maxHeight: string } {
  const own = ownSize(a);
  return { maxWidth: `min(100%, ${own.width}px)`, maxHeight: `min(100%, ${own.height}px)` };
}

/** One thumbnail. Its box has the image's shape from the start, so the stream doesn't jump when the bytes arrive. */
function Thumb({ attachment, load, onOpen }: { attachment: Attachment; load: LoadImage; onOpen: (a: Attachment, url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    const start = () => { load(attachment.id).then((u) => { if (alive) setUrl(u); }, () => { if (alive) setFailed(true); }); };
    const el = ref.current;
    // Fetch only when the thumbnail is on screen or close to it.
    if (!el || typeof IntersectionObserver === 'undefined') {
      start();
      return () => { alive = false; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); start(); }
    }, { rootMargin: '800px 0px' });
    observer.observe(el);
    return () => { alive = false; observer.disconnect(); };
  }, [attachment.id, load]);

  const box = thumbSize(attachment);
  return (
    <button
      ref={ref} type="button" disabled={!url}
      onClick={() => { if (url) onOpen(attachment, url); }}
      title={url ? `Open full size (${sizeLabel(attachment)})` : undefined}
      aria-label={`Image, ${sizeLabel(attachment)}${url ? ': open full size' : ''}`}
      style={{ width: box.width, aspectRatio: `${attachment.width} / ${attachment.height}` }}
      // box-content: the width above is the image's, and the border goes around it. With the border
      // inside, a 384-pixel screenshot would be squeezed into 380 and lose its sharp lines.
      className="box-content grid max-w-[calc(100%-2px)] cursor-zoom-in place-items-center overflow-hidden rounded-md border border-line bg-panel p-0 text-xs text-muted disabled:cursor-default"
    >
      {url
        ? <img src={url} alt={`Attached image, ${sizeLabel(attachment)}`} width={box.width} height={box.height} className="h-full w-full object-contain" />
        : <span className="px-2">{failed ? 'image could not be loaded' : `image ${sizeLabel(attachment)}…`}</span>}
    </button>
  );
}

/** What the full-size view shows. */
export interface Viewed {
  url: string;
  /** The image's pixels and its scale, when they are known. Unknown for a local file until it has loaded. */
  size?: { width: number; height: number; scale?: unknown };
  /** For a local file whose pixels the view measures itself: the scale to show them at, when the page knows it. */
  scale?: number;
  /** How many bytes it has, when that is known. */
  bytes?: number;
  /** The name under which "Save" offers it. Left out: no Save link (it is the reader's own file). */
  saveAs?: string;
}

/** The line at the top of the full-size view: pixels, scale and size, as far as they are known. */
export function viewedInfo(size: Viewed['size'], bytes?: number): string {
  const parts: string[] = [];
  if (size) parts.push(`${size.width}×${size.height}${validScale(size.scale) > 1 ? ` at ${validScale(size.scale)}×` : ''}`);
  if (bytes !== undefined) parts.push(`${Math.max(1, Math.round(bytes / 1024))} KB`);
  return parts.join(' · ');
}

/**
 * The size of the pop-out window for an image: its own size (in CSS pixels, at its scale), but no
 * larger than the screen, and not smaller than 320 × 240, so the browser's own controls fit.
 */
export function popoutSize(size: Viewed['size'], screen: { width: number; height: number }): { width: number; height: number } {
  const scale = size ? validScale(size.scale) : 1;
  const want = size ? { width: Math.round(size.width / scale), height: Math.round(size.height / scale) } : { width: 900, height: 700 };
  return {
    width: Math.max(320, Math.min(want.width + 24, Math.round(screen.width * 0.9))),
    height: Math.max(240, Math.min(want.height + 24, Math.round(screen.height * 0.9))),
  };
}

/**
 * Opens the image in a window of its own, so it can stay on screen next to the hub while one writes
 * about it. The image is already in this page (a blob: address of the same origin), so nothing is
 * fetched again and no token goes along. Returns whether the browser opened it.
 */
export function popOut(viewed: Pick<Viewed, 'url' | 'size'>, open: typeof window.open = window.open.bind(window)): boolean {
  const { width, height } = popoutSize(viewed.size, { width: window.screen?.availWidth || 1280, height: window.screen?.availHeight || 800 });
  return open(viewed.url, 'trialog-image', `popup=yes,width=${width},height=${height}`) !== null;
}

/**
 * The full-size view. The image first fits the window, and is not enlarged beyond its own size; a
 * click on it switches to its real size, every pixel of it, and back. A click outside the image,
 * the Close button or Escape closes the view. It is the same view for an image in the stream and
 * for one that is still waiting in the composer.
 *
 * When a message has several images (playground #1198), ← →, on-screen buttons and a swipe page
 * through them, with a «2/4» counter. They stop at the ends. Focus stays in the dialog while it is
 * open. A single image has none of that chrome, and works as it did.
 */
export function Lightbox({
  viewed,
  items,
  index = 0,
  onIndex,
  onClose,
}: {
  viewed?: Viewed;
  items?: readonly Viewed[];
  index?: number;
  onIndex?: (i: number) => void;
  onClose: () => void;
}) {
  const list = items ?? (viewed ? [viewed] : []);
  const current = list[index] ?? viewed;
  const count = list.length;
  const nav = count > 1;
  const bar = imageNav(index, count);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const startX = useRef<number | null>(null);
  const [realSize, setRealSize] = useState(false);
  // The browser refused the pop-out window: say so, and keep the view open.
  const [blocked, setBlocked] = useState(false);
  // A local file says how large it is only once it has loaded.
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => { setRealSize(false); setMeasured(null); }, [index, current?.url]);

  const go = useCallback((delta: number) => {
    if (!nav || !onIndex) return;
    const next = imageStep(index, count, delta);
    if (next !== index) onIndex(next);
  }, [nav, onIndex, index, count]);

  useEffect(() => {
    closeRef.current?.focus();
    const focusable = () => {
      const root = rootRef.current;
      if (!root) return [] as HTMLElement[];
      return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
    };
    const onKey = (e: KeyboardEvent) => {
      const f = focusable();
      const action = lightboxKey(e, {
        index, count, focusCount: f.length,
        focusIndex: f.indexOf(document.activeElement as HTMLElement),
      });
      if (!action) return;
      if (action.type === 'close') { e.preventDefault(); onClose(); return; }
      if (action.type === 'step') { e.preventDefault(); onIndex?.(action.index); return; }
      if (action.type === 'focus') { e.preventDefault(); f[action.index]?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onIndex, index, count]);

  if (!current) return null;
  const size = current.size ?? (measured ? { ...measured, scale: current.scale } : undefined);
  const info = viewedInfo(size, current.bytes);
  const onSwipeStart = (e: TouchEvent) => { startX.current = e.changedTouches[0]?.clientX ?? null; };
  const onSwipeEnd = (e: TouchEvent) => {
    const from = startX.current;
    startX.current = null;
    const to = e.changedTouches[0]?.clientX;
    if (from == null || to == null) return;
    const delta = swipeStep(from, to);
    if (delta) go(delta);
  };

  return (
    <div ref={rootRef} role="dialog" aria-modal="true"
      aria-label={nav ? `Image ${bar.at}, full size` : 'Image, full size'} onClick={onClose}
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center gap-3 bg-black px-4 py-2 text-[13px] text-muted" onClick={(e) => e.stopPropagation()}>
        <span>{info}</span>
        {blocked && <span role="status" className="text-bad">Pop-up blocked: allow pop-ups for this site, then try again.</span>}
        <span className="flex-1" />
        {current.saveAs && current.url && <a href={current.url} download={current.saveAs}>Save</a>}
        <button
          type="button" title="Open the image in its own window, next to the hub"
          onClick={() => { if (current.url && popOut({ url: current.url, size })) onClose(); else setBlocked(true); }}
          className="cursor-pointer rounded-md border border-line bg-transparent px-3 py-[5px] text-fg hover:bg-[#343a47] max-sm:hidden"
        >Pop out ↗</button>
        <button ref={closeRef} type="button" onClick={onClose} className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] text-fg hover:bg-[#343a47]">Close</button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto p-3"
        onTouchStart={nav ? onSwipeStart : undefined} onTouchEnd={nav ? onSwipeEnd : undefined}>
        {current.url
          ? <img src={current.url} alt={size ? `Attached image, ${size.width}×${size.height}` : 'Attached image'}
              onLoad={(e) => { if (!current.size) setMeasured({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); }}
              onClick={(e) => { e.stopPropagation(); setRealSize((v) => !v); }}
              title={realSize ? 'Fit to window' : 'Show at real size'}
              style={realSize ? undefined : (size ? fitLimits(size) : { maxWidth: '100%', maxHeight: '100%' })}
              className={realSize ? 'mx-auto block max-w-none cursor-zoom-out' : 'mx-auto block cursor-zoom-in object-contain'} />
          : <p className="m-0 grid h-full place-items-center text-sm text-muted">image…</p>}
        {nav && (
          <div data-image-nav="" className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center justify-center gap-3" onClick={(e) => e.stopPropagation()}>
            <button type="button" data-image-prev="" aria-label="Previous image" disabled={!bar.prev} onClick={() => go(-1)}
              className="pointer-events-auto flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-line bg-[#2a2f3a] text-lg text-fg hover:bg-[#343a47] disabled:cursor-default disabled:opacity-30">←</button>
            <span data-image-counter="" aria-live="polite" className="min-w-[3.5rem] text-center text-sm font-semibold tabular-nums text-fg">{bar.at}</span>
            <button type="button" data-image-next="" aria-label="Next image" disabled={!bar.next} onClick={() => go(1)}
              className="pointer-events-auto flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-line bg-[#2a2f3a] text-lg text-fg hover:bg-[#343a47] disabled:cursor-default disabled:opacity-30">→</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The images of one message: thumbnails, and the full-size view of the one that was clicked. */
function viewedAttachment(a: Attachment, url: string): Viewed {
  return { url, size: a, bytes: a.bytes, saveAs: `${a.id}.${EXTENSION[a.content_type] ?? 'img'}` };
}

export function MessageImages({ attachments, load }: { attachments: Attachment[]; load: LoadImage }) {
  const [index, setIndex] = useState<number | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const remember = useCallback((id: string, url: string) => {
    setUrls((cur) => (cur[id] === url ? cur : { ...cur, [id]: url }));
  }, []);
  const openAt = useCallback((i: number, url?: string) => {
    const a = attachments[i];
    if (!a) return;
    if (url) remember(a.id, url);
    else if (!urls[a.id]) load(a.id).then((u) => remember(a.id, u), () => {});
    setIndex(i);
    for (const j of [i - 1, i + 1]) {
      const n = attachments[j];
      if (n && !urls[n.id]) load(n.id).then((u) => remember(n.id, u), () => {});
    }
  }, [attachments, load, remember, urls]);
  const close = useCallback(() => setIndex(null), []);
  if (!attachments.length) return null;
  const items = attachments.map((a) => viewedAttachment(a, urls[a.id] ?? ''));
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2">
      {attachments.map((a, i) => (
        <Thumb
          key={a.id} attachment={a} load={load}
          onOpen={(_attachment, url) => openAt(i, url)}
        />
      ))}
      {index !== null && typeof document !== 'undefined' && createPortal(
        <Lightbox items={items} index={index} onIndex={(i) => openAt(i)} onClose={close} />,
        document.body,
      )}
    </div>
  );
}

/** An image waiting in the composer. `preview` is a blob: URL of the local file. */
export interface Draft {
  key: number;
  name: string;
  preview: string;
  state: 'uploading' | 'ready' | 'failed';
  attachment?: Attachment;
  error?: string;
  /** What the page knows about the file's scale before the server has stored it (see localScale). */
  scale?: number;
}

/** What opens the full-size view of an image in the composer: "View image", and the file's name when it has one. */
export const viewLabel = (d: Pick<Draft, 'name'>): string => (d.name && d.name !== 'image' ? `View image ${d.name}` : 'View image');

/**
 * What the full-size view shows for an image in the composer. It is the local file, so it can be
 * looked at before the upload has finished, and also when the upload failed. Once the server has
 * stored the image, its size on the page is the stored one, the size it will have in the stream;
 * until then the view measures the file itself and uses what the page knows about its scale.
 */
export function viewedDraft(d: Draft): Viewed {
  if (d.attachment) return { url: d.preview, size: { width: d.attachment.width, height: d.attachment.height, scale: d.attachment.scale }, bytes: d.attachment.bytes };
  return d.scale ? { url: d.preview, scale: d.scale } : { url: d.preview };
}


/**
 * The drafts that stay in the composer after a message went out with `sent`. Anything added while
 * that message was on its way (a paste or a drop after Send was pressed) was not part of it and stays.
 */
export function withoutSent(drafts: Draft[], sent: Draft[]): Draft[] {
  const gone = new Set(sent.map((d) => d.key));
  return drafts.filter((d) => !gone.has(d.key));
}

/** The images above the message box, as chips. The page puts them into its one row of chips. */
export function DraftChips({ drafts, onRemove }: { drafts: Draft[]; onRemove: (key: number) => void }) {
  // The image whose full-size view is open, and the chip that opened it.
  const [viewing, setViewing] = useState<number | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setViewing(null);
    // Back to where the reader was: the chip. The draft itself was never touched.
    opener.current?.focus();
    opener.current = null;
  }, []);
  const viewed = drafts.find((d) => d.key === viewing);
  return (
    <>
      {drafts.map((d) => (
        <Chip
          key={d.key} tone={d.state === 'failed' ? 'bad' : 'plain'} title={d.state === 'failed' ? d.error : d.name}
          visual={<img src={d.preview} alt="" className={`h-7 w-7 rounded object-cover ${d.state === 'uploading' ? 'opacity-50' : ''}`} />}
          onRemove={() => onRemove(d.key)} removeLabel={`Remove image ${d.name}`}
          // A click on the preview shows the image large, from the local file: before it is sent,
          // while it is still uploading, and when the upload failed.
          onOpen={(button) => { opener.current = button; setViewing(d.key); }} openLabel={viewLabel(d)}
        >
          {d.state === 'uploading' && <span className="text-muted">uploading…</span>}
          {d.state === 'ready' && d.attachment && <span className="text-muted">{sizeLabel(d.attachment)}</span>}
          {d.state === 'failed' && <span className="text-bad">{d.error}</span>}
        </Chip>
      ))}
      {/* The view lies over the whole page, so it is put at the end of the page, not into the row of chips. */}
      {viewed && typeof document !== 'undefined' && createPortal(
        <Lightbox
          items={drafts.map(viewedDraft)}
          index={Math.max(0, drafts.findIndex((d) => d.key === viewing))}
          onIndex={(i) => setViewing(drafts[i]?.key ?? null)}
          onClose={close}
        />,
        document.body,
      )}
    </>
  );
}

/** The scale of the screen this page is on: its device pixel ratio as a whole number from 1 to 3. */
export function screenScale(devicePixelRatio: number | undefined = typeof window === 'undefined' ? 1 : window.devicePixelRatio): number {
  const ratio = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return Math.min(MAX_SCALE_HINT, Math.max(1, Math.round(ratio)));
}

/**
 * What the page can tell about the scale of a file before it is uploaded. `recorded` is the
 * density the file itself records (dots per inch, or null); `pasted` says it came from the
 * clipboard, where a screenshot has usually lost that record, so the screen it was pasted on is
 * the best guess. A dropped or picked file gets no guess: it may come from anywhere.
 */
export function scaleOf(recorded: number | null, pasted: boolean, screen: number): number | null {
  return scaleFromDensity(recorded) ?? (pasted ? screen : null);
}

/**
 * The scale of a local file as far as the page can tell (scaleOf), from the density the file
 * records and from where it came. Null when the page knows nothing. The upload sends it along,
 * and the full-size view of an image in the composer uses it until the server has stored the image.
 */
export async function localScale(file: Blob, pasted = false): Promise<number | null> {
  let recorded: number | null = null;
  try {
    recorded = pngDensity(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
  } catch { /* unreadable here: the server will say so */ }
  return scaleOf(recorded, pasted, screenScale());
}

/**
 * The request that uploads one image: POST /api/attachments with the bytes as the body.
 *
 * The scale hint goes along when the page knows something the server can't read from the bytes:
 * for a pasted image, and for an image the page had to draw smaller (which loses what the file
 * recorded). The server prefers a density in the file itself, and uses the hint for display only.
 */
export async function uploadRequest(file: Blob, pasted = false): Promise<{ method: 'POST'; headers: Record<string, string>; body: Blob }> {
  const scale = await localScale(file, pasted);
  const prepared = await prepareForUpload(file, scale ?? 1);
  const headers: Record<string, string> = { 'Content-Type': prepared.blob.type || 'application/octet-stream' };
  if (pasted || prepared.blob !== file) headers[SCALE_HINT_HEADER] = String(Math.min(MAX_SCALE_HINT, prepared.scale));
  return { method: 'POST', headers, body: prepared.blob };
}

/**
 * An image the server will take: as it is when it is within the size limit, otherwise drawn
 * smaller (downsizePlan: a long edge of at most DOWNSIZE_LONG_EDGE pixels, and for an image with a
 * scale above 1, a size that keeps what it measures on the page). A PNG stays a PNG when that is
 * small enough; everything else becomes a JPEG. Drawing to a canvas also drops the file's
 * metadata, though the server removes it in any case. Returns the image and the scale it has now.
 */
export async function prepareForUpload(file: Blob, scale = 1): Promise<{ blob: Blob; scale: number }> {
  if (file.size <= MAX_ATTACHMENT_BYTES) return { blob: file, scale };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // applies the EXIF orientation
  } catch {
    throw new Error('This file is over 4 MB and the browser cannot read it as an image.');
  }
  const { width, height, scale: shrunk } = downsizePlan(bitmap.width, bitmap.height, scale, DOWNSIZE_LONG_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot shrink images. Make the image smaller than 4 MB first.');
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const fits = (blob: Blob | null): blob is Blob => blob !== null && blob.size <= MAX_ATTACHMENT_BYTES;
  try {
    if (file.type === 'image/png') {
      context.drawImage(bitmap, 0, 0, width, height);
      const png = await encode('image/png');
      if (fits(png)) return { blob: png, scale: shrunk };
    }
    // JPEG has no transparency: put the picture on white, not on black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.9, 0.8, 0.65]) {
      const jpeg = await encode('image/jpeg', quality);
      if (fits(jpeg)) return { blob: jpeg, scale: shrunk };
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`This image is still over 4 MB at ${DOWNSIZE_LONG_EDGE} px. Make it smaller first.`);
}
