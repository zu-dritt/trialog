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
    for (const file of files.slice(0, Math.max(0, ROADMAP_PICTURES_MAX - drafts.length))) {
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
