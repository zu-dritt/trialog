'use client';

// The roadmap board: four columns of cards (lib/roadmap.ts). Drag a card to a new place, in its
// column or another; on a phone or with the keyboard, use ↑ and ↓, and the column menu. Every
// change goes to the hub at once, so whoever looks next sees the same order.
import { Fragment, useEffect, useState, type DragEvent } from 'react';
import { DAY_END_HOUR, DAY_START_HOUR, ROADMAP_COLUMNS, cardStatus, todayLine, unblockHref, type CardStatus, type RoadmapColumn, type RoadmapItem, type TodayLine } from '../lib/roadmap';
import { colorOf, labelOf, type Participant } from '../lib/shared';
import { FlightText, flightAge, flightLinkLabel } from './flight';
import { MessageImages, type LoadImage } from './attachments';
import { ComposeIdea, EditCard, type CardEdit, type NewIdea } from './compose-idea';
import { REPO, pullRequestNumbers } from './links';
import { allMerged, settledByMerge } from './merged';
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

const hoursText = (h: number) => (h < 1 ? `${Math.round(h * 60)}\u00a0min` : `${Math.round(h * 10) / 10}\u00a0h`);

/** The words on the line: what is above it, and why there. */
export function todayLineText(line: TodayLine, cards: number): string {
  // Non-breaking spaces keep «5 h left» and «13 done in 6 h» on one line in a narrow column.
  const pace = `${line.done}\u00a0done in\u00a0${hoursText(line.hours)}`;
  if (line.left <= 0) return `▲ the day is over · ${pace}`;
  if (line.fits >= cards) return `▲ all of Next likely today · ${pace}, ${hoursText(line.left)}\u00a0left`;
  return `▲ likely today: ${line.fits === 0 ? 'nothing more from Next' : `the ${line.fits} above`} · ${pace}, ${hoursText(line.left)}\u00a0left`;
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
  /** «🚀 Ship it!» from a card: posts the go as a message with the 🚀 on it; true when sent. */
  ship?: (card: RoadmapItem, prs: readonly number[]) => Promise<boolean>;
  /** «🚀 Build it!» on a card in Next or Later (playground #1184/#1185): posts the go and moves the card to the top of Now; true when sent. */
  build?: (card: RoadmapItem) => Promise<boolean>;
  /** Changes a card's title and text (a card in Next or Later, playground #1098); true when saved. */
  edit?: (id: string, change: CardEdit) => Promise<boolean>;
  /** Deletes a card; true when it is gone. */
  remove?: (id: string) => Promise<boolean>;
}

/** Cards that can be edited: not yet started (Next or Later). Now and Done are history in the making. */
export const editable = (card: Pick<RoadmapItem, 'column'>): boolean => card.column === 'next' || card.column === 'later';

/**
 * The pull requests a card can be shipped as, from the board (playground #617): a card in review,
 * or one that waits on the orchestrator for a Ship it, whose note names a PR of this hub.
 */
export function shippable(card: Pick<RoadmapItem, 'column' | 'note' | 'owner' | 'updated_at'>, now: number, humans?: readonly string[], repo: string | null = REPO, merged: ReadonlySet<number> = new Set()): number[] {
  if (allMerged(card.note, merged, repo)) return []; // shipped already (#813)
  const status = cardStatus(card, now, humans?.length ? humans : undefined);
  if (status?.tone !== 'review' && !(status?.tone === 'blocked' && /ship it/i.test(card.note))) return [];
  return pullRequestNumbers(card.note, repo);
}

/**
 * The card's light on the board: like cardStatus, but a card whose PRs are all merged is no longer
 * red or amber, whatever its note still says (playground #813). It reads «merged».
 */
export function boardStatus(card: Pick<RoadmapItem, 'column' | 'note' | 'owner' | 'updated_at'>, now: number, humans?: readonly string[], merged: ReadonlySet<number> = new Set(), repo: string | null = REPO): CardStatus | null {
  const status = cardStatus(card, now, humans?.length ? humans : undefined);
  // In review: merged settles it. Waiting on the orchestrator: only a wait for a Ship it or a merge.
  if ((status?.tone === 'review' && allMerged(card.note, merged, repo)) || (status?.tone === 'blocked' && settledByMerge(card.note, merged, repo))) return { tone: 'working', label: 'merged' };
  return status;
}

/** The message a Ship it from the board posts; the 🚀 on it is the go, as on any message. */
export function shipText(card: Pick<RoadmapItem, 'title'>, prs: readonly number[]): string {
  return `🚀 Ship it! ${prs.map((n) => `PR ${n}`).join(', ')} (from the roadmap card «${card.title}»)`;
}

export { buildText } from '../lib/build-it';

/** Whether a card gets the Build it button: the orchestrator's, on a card not yet started (Next or Later). */
export function buildable(card: Pick<RoadmapItem, 'column'>, human: boolean): boolean {
  return human && (card.column === 'next' || card.column === 'later');
}

/** «just now», «12 min», «3 h», «2 d»: short enough for one line on a card. */
export function shortAge(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Why a card in «Next» stands where it does (playground #1327, migration 021):
 * - a human dragged it there: «📌 David moved it here · 12 min ago» (their override, and it stays put);
 * - otherwise how long it has waited: «In Next for 3 d»;
 * - a card from before migration 021 says who last changed it.
 * A card that waits on a human already says so with its red light.
 */
export function whyHere(card: Pick<RoadmapItem, 'column' | 'updated_by' | 'updated_at'> & Partial<Pick<RoadmapItem, 'moved_by' | 'moved_at' | 'entered_next_at'>>, participants: readonly Participant[], now: number): string | null {
  if (card.column !== 'next') return null;
  const human = participants.some((p) => p.name === card.moved_by && p.kind === 'human');
  if (human && card.moved_by && card.moved_at) return `📌 ${labelOf(card.moved_by, participants)} moved it here · ${shortAge(card.moved_at, now)}`;
  if (card.entered_next_at) return `In Next for ${shortAge(card.entered_next_at, now).replace(/ ago$/, '').replace(/^just now$/, 'a moment')}`;
  return `Last change: ${labelOf(card.updated_by, participants)} · ${shortAge(card.updated_at, now)}`;
}

/** The agents whose one pick is this card («Claude's pick»), in the roster's order. */
export function picksOf(cardId: string, picks: readonly { participant: string; item_id: string }[], participants: readonly Participant[]): string[] {
  const who = new Set(picks.filter((p) => p.item_id === cardId).map((p) => p.participant));
  return participants.filter((p) => who.has(p.name)).map((p) => labelOf(p.name, participants));
}

/**
 * Who builds and who reviews a card, as the card says it: «Claude builds · Grok reviews», in Done
 * «built · reviewed». A human owner is shown by name only (the orchestrator decides, not builds).
 */
export function cardRoles(card: Pick<RoadmapItem, 'column' | 'owner' | 'reviewer'> & Partial<Pick<RoadmapItem, 'raised_by'>>, participants: readonly Pick<Participant, 'name' | 'kind'>[] = []): { name: string; role: 'raiser' | 'owner' | 'reviewer'; verb: string }[] {
  const done = card.column === 'done';
  const human = (n: string) => participants.some((p) => p.name === n && p.kind === 'human');
  const roles: { name: string; role: 'raiser' | 'owner' | 'reviewer'; verb: string }[] = [];
  // Who raised it comes first, so David knows whom to ask (playground #670). Raised and built by
  // the same one reads «Claude raised, builds», not the name twice. Unknown for older cards: nothing.
  const raiser = card.raised_by ?? null;
  if (raiser && raiser !== card.owner) roles.push({ name: raiser, role: 'raiser', verb: 'raised' });
  if (card.owner) {
    const verb = human(card.owner) ? '' : done ? 'built' : 'builds';
    roles.push({ name: card.owner, role: 'owner', verb: raiser === card.owner ? (verb ? `raised, ${verb}` : 'raised') : verb });
  }
  if (card.reviewer && card.reviewer !== card.owner) roles.push({ name: card.reviewer, role: 'reviewer', verb: done ? 'reviewed' : 'reviews' });
  return roles;
}

/**
 * How far a card is: a bar, the percent, the owner's short line and how long ago they said so
 * (migrations/017, set with `hub.js roadmap progress <id> 60 "geocoding done"`). Not in Done.
 */
export function ProgressBar({ card, now }: { card: Pick<RoadmapItem, 'column' | 'progress' | 'status' | 'progress_at'>; now: number }) {
  if (card.progress === null || card.column === 'done') return null;
  const pct = Math.max(0, Math.min(100, card.progress));
  const age = card.progress_at ? flightAge(card.progress_at, now) : '';
  return (
    <div className="mt-1.5" data-progress={pct}>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${pct}% done${card.status ? `: ${card.status}` : ''}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[#2a2f3a]">
        <div className="h-full rounded-full bg-[#3fb950]" style={{ width: `${pct}%` }} />
      </div>
      {/* The progressbar's label already says this to a screen reader; the line is for the eye. */}
      <div aria-hidden="true" className="mt-0.5 text-[11px] text-muted">
        <span className="font-semibold text-fg/90">{pct}%</span>{card.status && <> · <FlightText text={card.status} hidden /></>}{age && <span className="whitespace-nowrap"> · {age === 'now' ? 'just now' : `${age.replace(/ h (\d+)$/, ' h $1 min')} ago`}</span>}
      </div>
    </div>
  );
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


/**
 * A card in «Now», read-only (playground #1503, #1552): everything about it in one window, with no
 * way to change it, because someone is working on it. Esc or ✕ closes it.
 */
export function ViewCard({ card, participants = [], now, status, load, onClose, repo = REPO }: {
  card: RoadmapItem;
  /** The hub's repository, for the pull request links (TRIALOG_REPO). */
  repo?: string | null;
  participants?: readonly Participant[];
  now: number;
  status: CardStatus | null;
  load?: LoadImage;
  onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const prs = repo ? pullRequestNumbers(card.note, repo) : [];
  return (
    <div role="dialog" aria-modal="false" aria-label={`Card «${card.title}»`} data-view-window={card.id}
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-xl border border-line bg-panel shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[34rem] sm:rounded-xl sm:bottom-6">
      <div className="flex items-center justify-between rounded-t-xl bg-[#2a2f3a] px-4 py-2">
        <span className="text-sm font-semibold">Card in Now · read-only while someone works on it</span>
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="cursor-pointer rounded px-1.5 text-muted hover:text-fg">✕</button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4 text-sm">
        <h3 className="m-0 text-base font-semibold leading-snug">{card.title}{status && <CardLed status={status} />}</h3>
        {cardRoles(card, participants).length > 0 && (
          <div data-view-roles="">
            {cardRoles(card, participants).map((r, i) => (
              <Fragment key={`${r.role}:${r.name}`}>{i > 0 && ' · '}<span className="font-semibold" style={{ color: colorOf(r.name, participants) }}>{labelOf(r.name, participants)}</span>{r.verb && ` ${r.verb}`}</Fragment>
            ))}
          </div>
        )}
        {card.note && <div data-view-note=""><span className="text-muted">Note: </span><FlightText text={card.note} /></div>}
        {prs.length > 0 && (
          <div data-view-prs="">
            <span className="text-muted">Pull requests: </span>
            {prs.map((n, i) => <Fragment key={n}>{i > 0 && ', '}<a href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noopener noreferrer" className="text-accent">PR {n} ↗</a></Fragment>)}
          </div>
        )}
        <ProgressBar card={card} now={now} />
        {card.description && <p data-view-description="" className="m-0 whitespace-pre-wrap text-fg/90">{card.description}</p>}
        {load && card.attachments.length > 0 && <MessageImages attachments={card.attachments} load={load} />}
        <div className="text-xs text-muted">Last change: {labelOf(card.updated_by, participants)} · {shortAge(card.updated_at, now)}</div>
      </div>
    </div>
  );
}

export function RoadmapBoard({ items, participants = [], actions, busy = false, me = null, now, loadImage, merged = new Set(), picks = [] }: { items: readonly RoadmapItem[]; participants?: readonly Participant[]; actions?: BoardActions; busy?: boolean; me?: string | null; now?: Date; loadImage?: LoadImage; /** PRs known to be merged (useMergedPrs). */ merged?: ReadonlySet<number>; /** Each agent's one pick in Next (GET /api/roadmap/picks). */ picks?: readonly { participant: string; item_id: string }[] }) {
  const today = todayLine(items, now);
  const at = (now ?? new Date()).getTime();
  const humans = participants.filter((p) => p.kind === 'human').flatMap((p) => [p.name, p.label ?? '']).filter(Boolean);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<{ column: RoadmapColumn; index: number } | null>(null);
  // Cards shipped from this page, so the button turns into «go sent» and isn't pressed twice.
  const [shipped, setShipped] = useState<ReadonlySet<string>>(new Set());
  // A go on its way: a second click before the first answer must not post a second go (Grok's nit).
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const human = participants.some((p) => p.name === me && p.kind === 'human');
  // The card open in the edit window, if any.
  const [editing, setEditing] = useState<string | null>(null);
  const editCard = editing ? items.find((i) => i.id === editing) ?? null : null;
  // The card in «Now» open read-only, if any.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewCard = viewing ? items.find((i) => i.id === viewing && i.column === 'now') ?? null : null;
  const drop = (e: DragEvent, column: RoadmapColumn, index: number) => {
    e.preventDefault();
    const id = dragged ?? e.dataTransfer.getData('text/plain');
    setDragged(null); setOver(null);
    if (id && actions) actions.place(id, column, index);
  };
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy={busy}>
      {editCard && actions?.edit && actions.remove && (
        <EditCard key={editCard.id} card={editCard} busy={busy} onClose={() => setEditing(null)} upload={actions.upload} load={loadImage}
          onSave={(change) => actions.edit!(editCard.id, change)} onDelete={() => actions.remove!(editCard.id)} />
      )}
      {viewCard && (
        <ViewCard key={viewCard.id} card={viewCard} participants={participants} now={at} status={boardStatus(viewCard, at, humans, merged)} load={loadImage} onClose={() => setViewing(null)} />
      )}
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
                <li id={card.id} data-card-id={card.id}
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
                      <div className="text-sm font-semibold leading-snug">{actions?.edit && editable(card)
                        ? <button type="button" data-edit={card.id} draggable={false} onClick={() => setEditing(card.id)} title="Edit or delete this card"
                            className="cursor-pointer border-0 bg-transparent p-0 text-left font-semibold text-fg hover:underline hover:decoration-dotted">{card.title} <span aria-hidden="true" className="text-xs font-normal text-muted">✎</span></button>
                        : card.column === 'now'
                          ? <button type="button" data-view={card.id} draggable={false} onClick={() => setViewing(card.id)} title="Open this card (read-only while someone works on it)"
                              className="cursor-pointer border-0 bg-transparent p-0 text-left font-semibold text-fg hover:underline hover:decoration-dotted">{card.title}</button>
                          : card.title}{(() => { const st = boardStatus(card, at, humans, merged); return st && <CardLed status={st} />; })()}</div>
                      {(card.note || card.owner || card.reviewer || card.raised_by) && (
                        <div className="mt-0.5 text-xs text-muted">
                          {cardRoles(card, participants).map((r, i) => (
                            <Fragment key={`${r.role}:${r.name}`}>{i > 0 && ' · '}<span data-role={r.role} className="font-semibold" style={{ color: colorOf(r.name, participants) }}>{labelOf(r.name, participants)}</span>{r.verb && ` ${r.verb}`}</Fragment>
                          ))}
                          {(card.owner || card.reviewer || card.raised_by) && card.note && ' · '}<FlightText text={card.note} />
                        </div>
                      )}
                      {(() => {
                        const why = whyHere(card, participants, at);
                        if (!why) return null;
                        const picked = picksOf(card.id, picks, participants);
                        return (
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                            <span data-why="" className="whitespace-nowrap">{why}</span>
                            {picked.length > 0 && (
                              <span data-picks="" className="whitespace-nowrap font-semibold text-fg/80" title={`${picked.join(' and ')} would take this card next`}>
                                ⭐ {picked.map((n) => `${n}'s pick`).join(' · ')}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <ProgressBar card={card} now={at} />
                      <CardDetails card={card} load={loadImage} />
                      {(() => {
                        // Ship it from the card (playground #617): only for the orchestrator, only when the card names a PR.
                        const prs = actions?.ship && human ? shippable(card, at, humans, REPO, merged) : [];
                        if (!prs.length) return null;
                        if (shipped.has(card.id)) return <span data-shipped="" className="mt-1.5 inline-block text-xs font-semibold text-[#3fb950]">🚀 Go sent for {prs.map((n) => `PR ${n}`).join(', ')}</span>;
                        return (
                          <button type="button" data-ship={card.id} disabled={busy || sending.has(card.id)} draggable={false}
                            onClick={() => {
                              if (sending.has(card.id)) return;
                              setSending((s) => new Set(s).add(card.id));
                              void actions!.ship!(card, prs).then((ok) => { if (ok) setShipped((s) => new Set(s).add(card.id)); })
                                .finally(() => setSending((s) => { const n = new Set(s); n.delete(card.id); return n; }));
                            }}
                            title="Your go: posts «🚀 Ship it!» for this PR in the hub, to the reviewer. It doesn't merge anything itself."
                            className="mt-1.5 mr-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-[#3fb950] bg-[#3fb950]/15 px-2 py-0.5 text-xs font-semibold text-[#56d364] hover:bg-[#3fb950]/25 disabled:opacity-50">
                            🚀 Ship it! {prs.map((n) => `PR ${n}`).join(', ')}
                          </button>
                        );
                      })()}
                      {actions?.build && buildable(card, human) && (
                        <button type="button" data-build={card.id} disabled={busy || sending.has(card.id)} draggable={false}
                          onClick={() => {
                            if (sending.has(card.id)) return;
                            setSending((s) => new Set(s).add(card.id));
                            void actions.build!(card).finally(() => setSending((s) => { const n = new Set(s); n.delete(card.id); return n; }));
                          }}
                          title="Your go: posts «🚀 Build it!» for this card in the hub, which wakes the agents, and moves the card to the top of Now."
                          className="mt-1.5 mr-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-[#3fb950] bg-[#3fb950]/15 px-2 py-0.5 text-xs font-semibold text-[#56d364] hover:bg-[#3fb950]/25 disabled:opacity-50">
                          🚀 Build it!
                        </button>
                      )}
                      {(() => {
                        // A card that waits on a human, with an address in its note: one click to where it is unblocked.
                        const href = unblockHref(card, boardStatus(card, at, humans, merged));
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
