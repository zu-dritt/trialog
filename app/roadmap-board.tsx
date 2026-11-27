'use client';

// The roadmap board: four columns of cards (lib/roadmap.ts). Drag a card to a new place, in its
// column or another; on a phone or with the keyboard, use ↑ and ↓, and the column menu. Every
// change goes to the hub at once, so whoever looks next sees the same order.
import { useState, type DragEvent } from 'react';
import { ROADMAP_COLUMNS, type RoadmapColumn, type RoadmapItem } from '../lib/roadmap';
import { colorOf, labelOf, type Participant } from '../lib/shared';

export const COLUMN_TITLES: Record<RoadmapColumn, string> = { done: 'Done', now: 'Now', next: 'Next', later: 'Later / needs the orchestrator' };
const COLUMN_COLORS: Record<RoadmapColumn, string> = { done: '#3fb950', now: '#4fb3ff', next: '#d29922', later: '#c792ea' };

/** The ids of a column after moving `id` to `index` (it may come from another column). */
export function placeAt(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

export const columnOf = (items: readonly RoadmapItem[], column: RoadmapColumn): RoadmapItem[] =>
  items.filter((i) => i.column === column).sort((a, b) => a.position - b.position);

export interface BoardActions {
  /** Put `id` into `column` at `index`: a move (if the column changes) and the column's new order. */
  place: (id: string, column: RoadmapColumn, index: number) => void;
}

export function RoadmapBoard({ items, participants = [], actions, busy = false }: { items: readonly RoadmapItem[]; participants?: readonly Participant[]; actions?: BoardActions; busy?: boolean }) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<{ column: RoadmapColumn; index: number } | null>(null);
  const drop = (e: DragEvent, column: RoadmapColumn, index: number) => {
    e.preventDefault();
    const id = dragged ?? e.dataTransfer.getData('text/plain');
    setDragged(null); setOver(null);
    if (id && actions) actions.place(id, column, index);
  };
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy={busy}>
      {ROADMAP_COLUMNS.map((column) => {
        const cards = columnOf(items, column);
        return (
          <section key={column} aria-label={COLUMN_TITLES[column]} data-column={column}
            className="flex min-h-[8rem] flex-col rounded-xl border border-line bg-panel"
            onDragOver={(e) => { if (actions) { e.preventDefault(); if (!over || over.column !== column) setOver({ column, index: cards.length }); } }}
            onDrop={(e) => drop(e, column, over?.column === column ? over.index : cards.length)}
          >
            <div className="h-1.5 rounded-t-xl" style={{ background: COLUMN_COLORS[column] }} />
            <h2 className="m-0 px-3 pb-1 pt-2 text-base font-bold" style={{ color: COLUMN_COLORS[column] }}>{COLUMN_TITLES[column]} <span className="text-xs font-normal text-muted">{cards.length}</span></h2>
            <ol className="m-0 flex flex-1 list-none flex-col gap-2 p-2 pt-1">
              {cards.map((card, index) => (
                <li key={card.id} data-card-id={card.id}
                  draggable={Boolean(actions)}
                  onDragStart={(e) => { setDragged(card.id); e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { setDragged(null); setOver(null); }}
                  onDragOver={(e) => { if (!actions) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); const i = e.clientY < r.top + r.height / 2 ? index : index + 1; if (over?.column !== column || over.index !== i) setOver({ column, index: i }); }}
                  onDrop={(e) => { e.stopPropagation(); drop(e, column, over?.column === column ? over.index : index); }}
                  className={`rounded-lg border bg-[#1d212a] px-3 py-2 ${dragged === card.id ? 'opacity-40' : ''} ${over?.column === column && over.index === index && dragged ? 'border-t-4 border-t-accent' : 'border-line'} ${actions ? 'cursor-grab' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="w-5 flex-none pt-0.5 text-right text-xs tabular-nums text-muted">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold leading-snug">{card.title}</div>
                      {(card.note || card.owner) && (
                        <div className="mt-0.5 text-xs text-muted">
                          {card.owner && <span className="font-semibold" style={{ color: colorOf(card.owner, participants) }}>{labelOf(card.owner, participants)}</span>}
                          {card.owner && card.note && ' · '}{card.note}
                        </div>
                      )}
                    </div>
                    {actions && (
                      <span className="flex flex-none flex-col gap-0.5">
                        <button type="button" disabled={busy || index === 0} onClick={() => actions.place(card.id, column, index - 1)} aria-label={`Move «${card.title}» up`} className="cursor-pointer rounded border border-line bg-transparent px-1.5 text-xs leading-5 text-muted hover:text-fg disabled:opacity-30">↑</button>
                        <button type="button" disabled={busy || index === cards.length - 1} onClick={() => actions.place(card.id, column, index + 1)} aria-label={`Move «${card.title}» down`} className="cursor-pointer rounded border border-line bg-transparent px-1.5 text-xs leading-5 text-muted hover:text-fg disabled:opacity-30">↓</button>
                      </span>
                    )}
                  </div>
                  {actions && (
                    <label className="mt-1 flex items-center gap-1 pl-7 text-[11px] text-muted">
                      <span className="sr-only">Column of «{card.title}»</span>
                      <select value={column} disabled={busy} onChange={(e) => actions.place(card.id, e.target.value as RoadmapColumn, Number.MAX_SAFE_INTEGER)} className="rounded border border-line bg-bg px-1 py-0.5 text-[11px] text-muted">
                        {ROADMAP_COLUMNS.map((c) => <option key={c} value={c}>{COLUMN_TITLES[c]}</option>)}
                      </select>
                    </label>
                  )}
                </li>
              ))}
              {!cards.length && <li className="px-2 py-4 text-center text-xs text-muted">{actions ? 'Drop a card here' : 'Nothing here'}</li>}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
