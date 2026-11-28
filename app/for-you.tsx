'use client';

// «⛔ n for you» in the header (lib/for-you.ts): what waits on the person signed in, in one list.
// Hidden when nothing waits. A decision jumps to its message in the hub; a card opens the roadmap
// (or the address in its note); an agent's wait just says what it needs. Asks every 30 seconds,
// also in a hidden tab until it naps (app/nap.ts), so the «Waiting on you» sound can ring there.
import { useEffect, useRef, useState } from 'react';
import type { ForYouItem } from '../lib/for-you';
import { watchNap } from './nap';

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;
export const FOR_YOU_POLL_MS = 30_000;

/** How many items are new since the last poll (by their stable `key`). The first poll is what was already there: 0. */
export function newWaits(seen: ReadonlySet<string> | null, items: readonly ForYouItem[]): number {
  return seen ? items.filter((i) => !seen.has(i.key)).length : 0;
}

export function forYouLabel(n: number): string {
  return `⛔ ${n} for you`;
}

export function ForYouList({ items, onMessage }: { items: readonly ForYouItem[]; onMessage: (room: string, id: number) => void }) {
  return (
    <ol data-for-you-list="" className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((item) => {
        const icon = item.kind === 'decision' ? '🗳' : item.kind === 'card' ? '🗂' : item.kind === 'silent' ? '💤' : '⏳';
        const line = <><span aria-hidden="true" className="mr-1.5">{icon}</span>{item.text}</>;
        const cls = 'block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-[#2a2f3a]';
        return (
          <li key={item.key} data-kind={item.kind}>
            {item.message
              ? <button type="button" className={`${cls} cursor-pointer border-0 bg-transparent`} onClick={() => onMessage(item.message!.room, item.message!.id)}>{line}</button>
              : item.href
                ? <a className={`${cls} no-underline`} href={item.href} target={item.href.startsWith('/roadmap') ? 'trialog-roadmap' : '_blank'} rel="noopener noreferrer">{line}</a>
                : <span className={`${cls} text-muted`}>{line}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function ForYouButton({ api, onMessage, onNew }: { api: ApiFn | null; onMessage: (room: string, id: number) => void; onNew?: () => void }) {
  const [items, setItems] = useState<ForYouItem[]>([]);
  const seen = useRef<Set<string> | null>(null);
  const heard = useRef(onNew);
  heard.current = onNew;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!api) return undefined;
    let gone = false;
    seen.current = null;
    const load = () => api('/api/for-you').then((r) => r.json()).then((d: { items?: ForYouItem[] }) => {
      if (gone || !Array.isArray(d.items)) return;
      if (newWaits(seen.current, d.items) > 0) heard.current?.();
      seen.current = new Set(d.items.map((i) => i.key));
      setItems(d.items);
    }, () => {});
    void load();
    // A hidden tab keeps asking until it naps, so the database can still sleep at night.
    const nap = watchNap(document, () => {});
    const t = setInterval(() => { if (!nap.napping) void load(); }, FOR_YOU_POLL_MS);
    return () => { gone = true; clearInterval(t); nap.stop(); };
  }, [api]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={box} className="relative flex-none">
      <button type="button" data-for-you="" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="What waits on you: decisions, cards and agents' requests"
        className="cursor-pointer rounded-md border border-bad bg-[#2a1618] px-3 py-[5px] text-sm font-semibold text-[#ff7b72] hover:bg-[#3a1d20]">{forYouLabel(items.length)}</button>
      {open && (
        <div role="dialog" aria-label="What waits on you" className="absolute right-0 top-full z-40 mt-1 w-[26rem] max-w-[90vw] rounded-lg border border-line bg-panel p-2 shadow-2xl">
          <div className="px-2 pb-1 text-xs font-semibold text-muted">What waits on you, oldest first</div>
          <ForYouList items={items} onMessage={(room, id) => { setOpen(false); onMessage(room, id); }} />
        </div>
      )}
    </div>
  );
}
