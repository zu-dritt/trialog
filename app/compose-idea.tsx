'use client';

// «✎ Compose»: an idea for the roadmap in full, like Gmail's Compose window (playground #636). A
// title, a description with line breaks, and pictures, pasted or chosen. It becomes a card at the
// top of «Later». No message is sent, so nobody is woken. Esc or ✕ closes it; what was typed stays
// until it is sent, so closing by mistake loses nothing.
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { ROADMAP_DESCRIPTION_MAX, ROADMAP_PICTURES_MAX, ROADMAP_TITLE_MAX } from '../lib/roadmap';
import type { Attachment } from '../lib/shared';
import { ACCEPT, DraftChips, type Draft } from './attachments';

export interface NewIdea { title: string; description: string; attachments: string[] }

export interface ComposeProps {
  /** Adds the card; true when it was saved. */
  onAdd: (idea: NewIdea) => Promise<boolean>;
  /** Uploads one picture; pasted says it came from the clipboard (a screenshot). */
  upload: (file: Blob, pasted: boolean) => Promise<Attachment>;
  busy?: boolean;
  /** Starts open (for a picture or a test). */
  defaultOpen?: boolean;
}

/** What the Send button says, and whether it can be pressed. */
export function composeState(title: string, drafts: readonly Pick<Draft, 'state'>[], busy: boolean): { ready: boolean; label: string } {
  if (drafts.some((d) => d.state === 'uploading')) return { ready: false, label: 'Uploading…' };
  if (busy) return { ready: false, label: 'Adding…' };
  return { ready: title.trim().length > 0 && !drafts.some((d) => d.state === 'failed'), label: 'Add to Later' };
}

export function ComposeIdea({ onAdd, upload, busy = false, defaultOpen = false }: ComposeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const nextKey = useRef(1);
  // How many pictures there are, also between renders: two quick pastes must not both see room for 6.
  const count = useRef(0);
  count.current = drafts.length;
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) titleRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);

  const addImages = (files: File[], pasted: boolean) => {
    const room = Math.max(0, ROADMAP_PICTURES_MAX - count.current);
    count.current += Math.min(room, files.length);
    for (const file of files.slice(0, room)) {
      const key = nextKey.current++;
      setDrafts((d) => [...d, { key, name: file.name || 'image', preview: URL.createObjectURL(file), state: 'uploading' }]);
      upload(file, pasted)
        .then((attachment) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, state: 'ready', attachment } : x))))
        .catch((e: unknown) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, state: 'failed', error: e instanceof Error ? e.message : 'Upload failed' } : x))));
    }
  };
  const paste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    addImages(files, true);
  };
  const state = composeState(title, drafts, busy);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!state.ready) return;
    const ok = await onAdd({ title: title.trim(), description: description.trim(), attachments: drafts.flatMap((d) => (d.attachment ? [d.attachment.id] : [])) });
    if (!ok) return;
    for (const d of drafts) URL.revokeObjectURL(d.preview);
    setTitle(''); setDescription(''); setDrafts([]); setOpen(false);
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-compose="" aria-haspopup="dialog"
        title="Write an idea in full, with pictures. It goes to the top of Later and wakes no one."
        className="mx-2 mb-1 inline-flex cursor-pointer items-center gap-2 self-start rounded-2xl border border-line bg-[#e6e8ee] px-4 py-2 text-sm font-semibold text-[#0f1115] shadow hover:bg-white">
        <span aria-hidden="true">✎</span> Compose{(title || description || drafts.length) ? ' (draft)' : ''}
      </button>
      {open && (
        <div role="dialog" aria-modal="false" aria-label="New idea for the roadmap" data-compose-window=""
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-xl border border-line bg-panel shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[34rem] sm:rounded-xl sm:bottom-6">
          <div className="flex items-center justify-between rounded-t-xl bg-[#2a2f3a] px-4 py-2">
            <span className="text-sm font-semibold">New idea · top of Later · wakes no one</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close (the draft stays)" title="Close (the draft stays)" className="cursor-pointer rounded px-1.5 text-muted hover:text-fg">✕</button>
          </div>
          <form onSubmit={(e) => { void submit(e); }} className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ROADMAP_TITLE_MAX} placeholder="Title: the idea in one line"
              aria-label="Title of the idea" className="rounded-md border border-line bg-bg px-2 py-1.5 text-sm font-semibold" onPaste={paste} />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={ROADMAP_DESCRIPTION_MAX} onPaste={paste}
              placeholder="Say it in full. Paste a screenshot of an app you like (⌘V), or add pictures below."
              aria-label="Description of the idea" className="min-h-[10rem] flex-1 resize-y rounded-md border border-line bg-bg px-2 py-1.5 text-sm leading-relaxed" />
            {drafts.length > 0 && <div className="flex flex-wrap gap-1.5"><DraftChips drafts={drafts} onRemove={(key) => setDrafts((d) => d.filter((x) => x.key !== key))} /></div>}
            <div className="flex items-center gap-2">
              <button type="submit" disabled={!state.ready} className="cursor-pointer rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-[#0f1115] disabled:cursor-default disabled:opacity-40">{state.label}</button>
              <button type="button" onClick={() => fileRef.current?.click()} disabled={drafts.length >= ROADMAP_PICTURES_MAX} className="cursor-pointer rounded-md border border-line bg-transparent px-2 py-1 text-sm text-muted hover:text-fg disabled:opacity-40">Image</button>
              <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { addImages(Array.from(e.target.files ?? []), false); e.target.value = ''; }} />
              <span className="ml-auto text-xs text-muted">{[...description].length}/{ROADMAP_DESCRIPTION_MAX}</span>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export interface CardEdit { title: string; description: string; /** The pictures' upload ids, in order; left out: unchanged. */ attachments?: string[] }

/** Shown until a picture's bytes have loaded: an empty src would make the browser fetch the page itself. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The ids of the drafts that are uploaded, in order. */
const readyIds = (drafts: readonly Pick<Draft, 'attachment'>[]): string[] => drafts.flatMap((d) => (d.attachment ? [d.attachment.id] : []));

/**
 * What the edit window's Save says, and whether it can be pressed: a title, nothing still
 * uploading or failed, and something changed (title, text, or the pictures and their order).
 */
export function editState(card: { title: string; description: string; attachments?: readonly { id: string }[] }, title: string, description: string, busy: boolean, drafts: readonly Pick<Draft, 'state' | 'attachment'>[] = []): { ready: boolean; label: string } {
  if (drafts.some((d) => d.state === 'uploading')) return { ready: false, label: 'Uploading…' };
  if (busy) return { ready: false, label: 'Saving…' };
  const had = (card.attachments ?? []).map((a) => a.id);
  const now = readyIds(drafts);
  const pictures = had.length !== now.length || had.some((id, i) => id !== now[i]);
  const changed = title.trim() !== card.title || description.trim() !== card.description.trim() || pictures;
  return { ready: title.trim().length > 0 && changed && !drafts.some((d) => d.state === 'failed'), label: 'Save' };
}

/**
 * The same window as Compose, for a card in Next or Later (playground #1098): change its title, text
 * and pictures (#1403: remove one with ×, add with Image or paste), or delete the card. Delete asks
 * once more, since it can't be undone.
 */
export function EditCard({ card, onSave, onDelete, onClose, busy = false, upload, load }: {
  card: Omit<CardEdit, 'attachments'> & { id: string; attachments?: readonly Attachment[] };
  onSave: (change: CardEdit) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onClose: () => void;
  busy?: boolean;
  /** Uploads a new picture; without it (and `load`), the pictures can't be changed here. */
  upload?: (file: Blob, pasted: boolean) => Promise<Attachment>;
  load?: (id: string) => Promise<string>;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  // The card's pictures as the same chips as in Compose; new ones are added after them.
  const [drafts, setDrafts] = useState<Draft[]>(() => (card.attachments ?? []).map((a, i) => ({ key: -(i + 1), name: `picture ${i + 1}`, preview: BLANK, state: 'ready' as const, attachment: a })));
  const nextKey = useRef(1);
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = Boolean(upload && load);
  useEffect(() => {
    if (!load) return;
    for (const a of card.attachments ?? []) {
      load(a.id).then((url) => setDrafts((d) => d.map((x) => (x.attachment?.id === a.id ? { ...x, preview: url } : x))), () => {});
    }
  }, [card.attachments, load]);
  const addImages = (files: File[], pasted: boolean) => {
    if (!upload) return;
    const room = Math.max(0, ROADMAP_PICTURES_MAX - drafts.length);
    for (const file of files.slice(0, room)) {
      const key = nextKey.current++;
      setDrafts((d) => [...d, { key, name: file.name || 'image', preview: URL.createObjectURL(file), state: 'uploading' }]);
      upload(file, pasted)
        .then((attachment) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, state: 'ready', attachment } : x))))
        .catch((e: unknown) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, state: 'failed', error: e instanceof Error ? e.message : 'Upload failed' } : x))));
    }
  };
  const paste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length || !editable) return;
    e.preventDefault();
    addImages(files, true);
  };
  // Delete asks in the window itself (David, playground #1306: the browser's box shows the site's
  // address and a bare «OK»). Esc or «Keep it» goes back.
  const [confirming, setConfirming] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) keepRef.current?.focus(); }, [confirming]);
  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (confirming) setConfirming(false); else onClose(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, confirming]);
  const state = editState(card, title, description, busy, editable ? drafts : (card.attachments ?? []).map((attachment) => ({ state: 'ready' as const, attachment })));
  const pictures = editable ? drafts.length : card.attachments?.length ?? 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!state.ready) return;
    if (await onSave({ title: title.trim(), description: description.trim(), ...(editable ? { attachments: readyIds(drafts) } : {}) })) onClose();
  };
  const remove = async () => {
    if (await onDelete()) onClose();
    else setConfirming(false);
  };
  return (
    <div role="dialog" aria-modal="false" aria-label={`Edit «${card.title}»`} data-edit-window={card.id}
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-xl border border-line bg-panel shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[34rem] sm:rounded-xl sm:bottom-6">
      <div className="flex items-center justify-between rounded-t-xl bg-[#2a2f3a] px-4 py-2">
        <span className="text-sm font-semibold">Edit card · wakes no one</span>
        <button type="button" onClick={onClose} aria-label="Close without saving" title="Close without saving" className="cursor-pointer rounded px-1.5 text-muted hover:text-fg">✕</button>
      </div>
      <form onSubmit={(e) => { void submit(e); }} className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ROADMAP_TITLE_MAX}
          aria-label="Title of the card" className="rounded-md border border-line bg-bg px-2 py-1.5 text-sm font-semibold" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={ROADMAP_DESCRIPTION_MAX}
          placeholder={editable ? 'Say it in full. Paste a screenshot (⌘V) to add a picture.' : 'Say it in full.'} aria-label="Description of the card" onPaste={paste}
          className="min-h-[10rem] flex-1 resize-y rounded-md border border-line bg-bg px-2 py-1.5 text-sm leading-relaxed" />
        {editable && drafts.length > 0 && <div data-card-pictures="" className="flex flex-wrap gap-1.5"><DraftChips drafts={drafts} onRemove={(key) => setDrafts((d) => d.filter((x) => x.key !== key))} /></div>}
        {confirming ? (
          <div role="alertdialog" aria-label="Delete this card?" data-confirm-delete={card.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-[#f85149] bg-[#f85149]/10 px-3 py-2">
            <span className="min-w-0 flex-1 text-sm text-fg">Delete «{card.title}»{pictures > 0 && ` and its ${pictures === 1 ? 'picture' : `${pictures} pictures`}`}? <span className="text-muted">This can't be undone.</span></span>
            <button ref={keepRef} type="button" data-keep-card="" onClick={() => setConfirming(false)}
              className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-1 text-sm text-fg hover:bg-[#343a47]">Keep it</button>
            <button type="button" data-delete-for-good={card.id} onClick={() => { void remove(); }} disabled={busy}
              className="cursor-pointer rounded-md border border-[#f85149] bg-[#f85149] px-3 py-1 text-sm font-semibold text-[#0f1115] hover:bg-[#ff7b72] disabled:opacity-40">Delete for good</button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button type="submit" disabled={!state.ready} className="cursor-pointer rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-[#0f1115] disabled:cursor-default disabled:opacity-40">{state.label}</button>
            {editable && (
              <>
                <button type="button" onClick={() => fileRef.current?.click()} disabled={drafts.length >= ROADMAP_PICTURES_MAX} className="cursor-pointer rounded-md border border-line bg-transparent px-2 py-1 text-sm text-muted hover:text-fg disabled:opacity-40">Image</button>
                <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { addImages(Array.from(e.target.files ?? []), false); e.target.value = ''; }} />
              </>
            )}
            <button type="button" data-delete-card={card.id} onClick={() => setConfirming(true)} disabled={busy}
              className="cursor-pointer rounded-md border border-[#f85149] bg-transparent px-2 py-1 text-sm text-[#ff7b72] hover:bg-[#f85149]/15 disabled:opacity-40">Delete</button>
            <span className="ml-auto text-xs text-muted">{pictures > 0 && `🖼 ${pictures}${editable ? '' : ' stay'} · `}{[...description].length}/{ROADMAP_DESCRIPTION_MAX}</span>
          </div>
        )}
      </form>
    </div>
  );
}
