'use client';

// The roadmap board: four columns of cards (lib/roadmap.ts). Drag a card to a new place, in its
// column or another; on a phone or with the keyboard, use ↑ and ↓, and the column menu. Every
// change goes to the hub at once, so whoever looks next sees the same order.
import { Fragment, useState, type DragEvent } from 'react';
import { DAY_END_HOUR, DAY_START_HOUR, ROADMAP_COLUMNS, cardStatus, todayLine, unblockHref, type CardStatus, type RoadmapColumn, type RoadmapItem, type TodayLine } from '../lib/roadmap';
import { colorOf, labelOf, type Participant } from '../lib/shared';
import { FlightText, flightLinkLabel } from './flight';
import { MessageImages, type LoadImage } from './attachments';
import { ComposeIdea, type NewIdea } from './compose-idea';
import type { Attachment } from '../lib/shared';

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

/** The LED colours, the same as the work-in-flight strip's dots. */
const LED: Record<CardStatus['tone'], string> = { blocked: '#f85149', review: '#d29922', working: '#3fb950', stale: '#6e7681' };

/** A card's LED and its word: red and blinking when it waits on the orchestrator. */
export function CardLed({ status }: { status: CardStatus }) {
  return (
    <span data-led={status.tone} className={`ml-1.5 inline-flex items-center gap-1 align-middle text-[11px] font-semibold ${status.tone === 'blocked' ? 'text-[#ff7b72]' : 'text-muted'}`}>
      <span aria-hidden="true" className={`inline-block flex-none rounded-full ${status.tone === 'blocked' ? 'h-2.5 w-2.5 blink-red' : 'h-2 w-2'}`} style={{ background: LED[status.tone] }} />
      {status.label}
    </span>
  );
}

const hoursText = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`);

/** The words on the line: what is above it, and why there. */
export function todayLineText(line: TodayLine, cards: number): string {
  const pace = `${line.done} done in ${hoursText(line.hours)}`;
  if (line.left <= 0) return `▲ the day is over · ${pace}`;
  if (line.fits >= cards) return `▲ all of Next likely today · ${pace}, ${hoursText(line.left)} left`;
  return `▲ likely today: ${line.fits === 0 ? 'nothing more from Next' : `the ${line.fits} above`} · ${pace}, ${hoursText(line.left)} left`;
}

export interface BoardActions {
  /** Put `id` into `column` at `index`: a move (if the column changes) and the column's new order. */
  place: (id: string, column: RoadmapColumn, index: number) => void;
  /** Claim a card with no owner (the first claim wins), or let go of your own. */
  claim?: (id: string, take: boolean) => void;
  /** Adds an idea at the top of «Later»: a card, not a message, so it wakes no one. */
  addIdea?: (idea: NewIdea) => Promise<boolean>;
  /** Uploads a picture for an idea (the Compose window); without it, ideas have no pictures. */
  upload?: (file: Blob, pasted: boolean) => Promise<Attachment>;
}

/** A card's description and pictures, folded: the first line shows, the rest opens on a click. */
export function CardDetails({ card, load }: { card: Pick<RoadmapItem, 'description' | 'attachments'>; load?: LoadImage }) {
  if (!card.description && !card.attachments.length) return null;
  const first = card.description.split('\n')[0];
  return (
    <details className="mt-1 text-xs text-muted" data-details="">
      <summary className="cursor-pointer select-none truncate">{card.attachments.length > 0 && `🖼 ${card.attachments.length} · `}{first || 'Pictures'}</summary>
      {card.description && <p className="m-0 mt-1 whitespace-pre-wrap text-fg/90">{card.description}</p>}
      {load && card.attachments.length > 0 && <MessageImages attachments={card.attachments} load={load} />}
    </details>
  );
}


export function RoadmapBoard({ items, participants = [], actions, busy = false, me = null, now, loadImage }: { items: readonly RoadmapItem[]; participants?: readonly Participant[]; actions?: BoardActions; busy?: boolean; me?: string | null; now?: Date; loadImage?: LoadImage }) {
  const today = todayLine(items, now);
  const at = (now ?? new Date()).getTime();
  const humans = participants.filter((p) => p.kind === 'human').flatMap((p) => [p.name, p.label ?? '']).filter(Boolean);
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
            {column === 'later' && actions?.addIdea && actions.upload && <ComposeIdea onAdd={actions.addIdea} upload={actions.upload} busy={busy} />}
            <ol className="m-0 flex flex-1 list-none flex-col gap-2 p-2 pt-1">
              {cards.map((card, index) => (<Fragment key={card.id}>
                {column === 'next' && today && today.fits === index && <TodayMark line={today} cards={cards.length} onDragOver={(e) => { if (!actions) return; e.preventDefault(); e.stopPropagation(); if (over?.column !== column || over.index !== Math.max(0, index - 1)) setOver({ column, index: Math.max(0, index - 1) }); }} onDrop={(e) => { e.stopPropagation(); drop(e, column, Math.max(0, index - 1)); }} />}
                <li data-card-id={card.id}
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
                      <div className="text-sm font-semibold leading-snug">{card.title}{(() => { const st = cardStatus(card, at, humans.length ? humans : undefined); return st && <CardLed status={st} />; })()}</div>
                      {(card.note || card.owner) && (
                        <div className="mt-0.5 text-xs text-muted">
                          {card.owner && <span className="font-semibold" style={{ color: colorOf(card.owner, participants) }}>{labelOf(card.owner, participants)}</span>}
                          {card.owner && card.note && ' · '}<FlightText text={card.note} />
                        </div>
                      )}
                      <CardDetails card={card} load={loadImage} />
                      {(() => {
                        // A card that waits on a human, with an address in its note: one click to where it is unblocked.
                        const href = unblockHref(card, cardStatus(card, at, humans.length ? humans : undefined));
                        return href && (
                          <a href={href} target="_blank" rel="noopener noreferrer" data-unblock="" draggable={false} title={href}
                            className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-[#f85149] bg-[#f85149]/15 px-2 py-0.5 text-xs font-semibold text-[#ff7b72] no-underline hover:bg-[#f85149]/25">
                            Unblock → {flightLinkLabel(href)}
                          </a>
                        );
                      })()}
                    </div>
                    {actions && (
                      <span className="flex flex-none flex-col gap-0.5">
                        <button type="button" disabled={busy || index === 0} onClick={() => actions.place(card.id, column, index - 1)} aria-label={`Move «${card.title}» up`} className="cursor-pointer rounded border border-line bg-transparent px-1.5 text-xs leading-5 text-muted hover:text-fg disabled:opacity-30">↑</button>
                        <button type="button" disabled={busy || index === cards.length - 1} onClick={() => actions.place(card.id, column, index + 1)} aria-label={`Move «${card.title}» down`} className="cursor-pointer rounded border border-line bg-transparent px-1.5 text-xs leading-5 text-muted hover:text-fg disabled:opacity-30">↓</button>
                      </span>
                    )}
                  </div>
                  {/* Done is done: no column menu (drag or ↑ ↓ still move a card back). */}
                  {actions && column !== 'done' && (
                    <label className="mt-1 flex items-center gap-1 pl-7 text-[11px] text-muted">
                      <span className="sr-only">Column of «{card.title}»</span>
                      <select value={column} disabled={busy} onChange={(e) => actions.place(card.id, e.target.value as RoadmapColumn, Number.MAX_SAFE_INTEGER)} className="rounded border border-line bg-bg px-1 py-0.5 text-[11px] text-muted">
                        {ROADMAP_COLUMNS.map((c) => <option key={c} value={c}>{COLUMN_TITLES[c]}</option>)}
                      </select>
                      {actions.claim && me && card.owner === null && (
                        <button type="button" disabled={busy} data-claim={card.id} onClick={() => actions.claim!(card.id, true)} title="Take this card. The first claim wins." className="ml-auto cursor-pointer rounded border border-line bg-[#2a2f3a] px-2 py-0.5 text-[11px] text-fg hover:bg-[#343a47]">Claim</button>
                      )}
                      {actions.claim && me && card.owner === me && (
                        <button type="button" disabled={busy} data-release={card.id} onClick={() => actions.claim!(card.id, false)} title="Let go of this card" className="ml-auto cursor-pointer rounded border border-line bg-transparent px-2 py-0.5 text-[11px] text-muted hover:text-fg">Release</button>
                      )}
                    </label>
                  )}
                </li>
              </Fragment>))}
              {column === 'next' && today && cards.length > 0 && today.fits >= cards.length && <TodayMark line={today} cards={cards.length} />}
              {!cards.length && <li className="px-2 py-4 text-center text-xs text-muted">{actions ? 'Drop a card here' : 'Nothing here'}</li>}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** The dashed «likely today» line in «Next». A card dropped on it becomes the last one above it. */
function TodayMark({ line, cards, onDragOver, onDrop }: { line: TodayLine; cards: number; onDragOver?: (e: DragEvent) => void; onDrop?: (e: DragEvent) => void }) {
  return (
    <li role="separator" data-today-line={line.fits} onDragOver={onDragOver} onDrop={onDrop}
      className="flex items-center gap-2 py-1 text-[11px] font-semibold text-[#ffd166]"
      title={`Today's pace: cards in Done changed today, per hour since ${DAY_START_HOUR}:00 (or the first change, if earlier; a late start makes the pace look slower), times the hours left until ${DAY_END_HOUR}:00, less the cards in Now. Drag a card above the line to do it today.`}>
      <span className="h-0 w-4 flex-none border-t-2 border-dashed border-[#ffd166]" />
      <span className="min-w-0 flex-1 leading-snug">{todayLineText(line, cards)}</span>
    </li>
  );
}
