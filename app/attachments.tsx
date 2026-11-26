'use client';

// Images on the page: the thumbnails in the stream, the full-size view, the preview chips in the
// composer, and shrinking an image that is too large before it is uploaded.
//
// An image is only ever served with the Bearer token (GET /api/attachments/<id>), and an
// <img src="…"> can't send that header. So the page fetches the bytes itself and shows them from
// a blob: URL, which lives in this tab only. No <img> here ever points at the API.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DOWNSIZE_LONG_EDGE, IMAGE_TYPES, MAX_ATTACHMENT_BYTES, fitWithin, type Attachment } from '../lib/shared';
import { Chip } from './chips';

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

  const box = fitWithin(attachment.width, attachment.height, THUMB_MAX.width, THUMB_MAX.height);
  return (
    <button
      ref={ref} type="button" disabled={!url}
      onClick={() => { if (url) onOpen(attachment, url); }}
      title={url ? `Open full size (${sizeLabel(attachment)})` : undefined}
      aria-label={`Image, ${sizeLabel(attachment)}${url ? ': open full size' : ''}`}
      style={{ width: box.width, aspectRatio: `${attachment.width} / ${attachment.height}` }}
      className="grid max-w-full cursor-zoom-in place-items-center overflow-hidden rounded-md border border-line bg-panel p-0 text-xs text-muted disabled:cursor-default"
    >
      {url
        ? <img src={url} alt={`Attached image, ${sizeLabel(attachment)}`} width={attachment.width} height={attachment.height} className="h-full w-full object-contain" />
        : <span className="px-2">{failed ? 'image could not be loaded' : `image ${sizeLabel(attachment)}…`}</span>}
    </button>
  );
}

/**
 * The full-size view. The image first fits the window; a click on it switches to its real size
 * and back. A click outside the image, the Close button or Escape closes the view.
 */
function Lightbox({ attachment, url, onClose }: { attachment: Attachment; url: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [realSize, setRealSize] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Image, full size" onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col bg-black/90">
      <div className="flex items-center gap-3 px-4 py-2 text-[13px] text-muted" onClick={(e) => e.stopPropagation()}>
        <span>{sizeLabel(attachment)} · {Math.max(1, Math.round(attachment.bytes / 1024))} KB</span>
        <span className="flex-1" />
        <a href={url} download={`${attachment.id}.${EXTENSION[attachment.content_type] ?? 'img'}`}>Save</a>
        <button ref={closeRef} type="button" onClick={onClose} className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] text-fg hover:bg-[#343a47]">Close</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <img src={url} alt={`Attached image, ${sizeLabel(attachment)}`}
          onClick={(e) => { e.stopPropagation(); setRealSize((v) => !v); }}
          title={realSize ? 'Fit to window' : 'Show at real size'}
          className={realSize ? 'mx-auto block max-w-none cursor-zoom-out' : 'mx-auto block max-h-full max-w-full cursor-zoom-in object-contain'} />
      </div>
    </div>
  );
}

/** The images of one message: thumbnails, and the full-size view of the one that was clicked. */
export function MessageImages({ attachments, load }: { attachments: Attachment[]; load: LoadImage }) {
  const [open, setOpen] = useState<{ attachment: Attachment; url: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  if (!attachments.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2">
      {attachments.map((a) => <Thumb key={a.id} attachment={a} load={load} onOpen={(attachment, url) => setOpen({ attachment, url })} />)}
      {open && <Lightbox attachment={open.attachment} url={open.url} onClose={close} />}
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
  return (
    <>
      {drafts.map((d) => (
        <Chip
          key={d.key} tone={d.state === 'failed' ? 'bad' : 'plain'} title={d.state === 'failed' ? d.error : d.name}
          visual={<img src={d.preview} alt="" className={`h-7 w-7 rounded object-cover ${d.state === 'uploading' ? 'opacity-50' : ''}`} />}
          onRemove={() => onRemove(d.key)} removeLabel={`Remove image ${d.name}`}
        >
          {d.state === 'uploading' && <span className="text-muted">uploading…</span>}
          {d.state === 'ready' && d.attachment && <span className="text-muted">{sizeLabel(d.attachment)}</span>}
          {d.state === 'failed' && <span className="text-bad">{d.error}</span>}
        </Chip>
      ))}
    </>
  );
}

/**
 * An image the server will take: as it is when it is within the size limit, otherwise drawn
 * smaller, with a long edge of at most DOWNSIZE_LONG_EDGE pixels. A PNG stays a PNG when that is
 * small enough; everything else becomes a JPEG. Drawing to a canvas also drops the file's
 * metadata, though the server removes it in any case.
 */
export async function prepareForUpload(file: Blob): Promise<Blob> {
  if (file.size <= MAX_ATTACHMENT_BYTES) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // applies the EXIF orientation
  } catch {
    throw new Error('This file is over 4 MB and the browser cannot read it as an image.');
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height, DOWNSIZE_LONG_EDGE, DOWNSIZE_LONG_EDGE);
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
      if (fits(png)) return png;
    }
    // JPEG has no transparency: put the picture on white, not on black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.9, 0.8, 0.65]) {
      const jpeg = await encode('image/jpeg', quality);
      if (fits(jpeg)) return jpeg;
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`This image is still over 4 MB at ${DOWNSIZE_LONG_EDGE} px. Make it smaller first.`);
}
