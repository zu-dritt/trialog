// The roadmap: cards in four columns (done, now, next, later), in an order anyone can change. The
// orchestrator drags cards in «Next» and «Later» to say what matters most; the agents add, move and
// finish cards with hub.js. Stored in the hub (migrations/016-roadmap.sql).

import type { Attachment } from './shared';

export const ROADMAP_COLUMNS = ['done', 'now', 'next', 'later'] as const;
export type RoadmapColumn = (typeof ROADMAP_COLUMNS)[number];
export const ROADMAP_TITLE_MAX = 80;
export const ROADMAP_NOTE_MAX = 120;
export const ROADMAP_MAX_ITEMS = 200;
export const ROADMAP_ID = /^rm_[a-z0-9]{8,32}$/;
export const ROADMAP_DESCRIPTION_MAX = 4000;
export const ROADMAP_PICTURES_MAX = 6;

export interface RoadmapItem {
  id: string;
  column: RoadmapColumn;
  position: number;
  title: string;
  note: string;
  owner: string | null;
  updated_by: string;
  updated_at: string;
  /** How far the owner is, 0–100, or null when not said (migrations/017). */
  progress: number | null;
  /** A short line on where it stands («geocoding done»). */
  status: string;
  /** When progress or status was last set. */
  progress_at: string | null;
  /** The idea in full, with line breaks (0–4000 characters; migrations/018). */
  description: string;
  /** Pictures on the card, in order (served by GET /api/attachments/<id>). */
  attachments: Attachment[];
  /** Who reviews it: a participant, or null (migrations/018). «Claude builds · Grok reviews». */
  reviewer: string | null;
  /** Who added the card, or null for cards from before migrations/019 (playground #670). Never changed by an edit. */
  raised_by: string | null;
  /** Who last moved the card (a drag, ↑ ↓, the column menu or Build it; never an edit), and when (migrations/021). Null before. */
  moved_by: string | null;
  moved_at: string | null;
  /** When the card last entered «Next», or null (before migrations/021, or never in Next). */
  entered_next_at: string | null;
}

type Fail = { ok: false; status: number; error: string };

const line = (v: unknown, label: string, min: number, max: number): string | Fail => {
  if (typeof v !== 'string') return { ok: false, status: 400, error: `"${label}" must be text (${min}–${max} characters).` };
  const t = v.replace(/[\r\n\t]+/g, ' ').trim();
  if (/[\x00-\x1f\x7f]/.test(t) || [...t].length < min || [...t].length > max) return { ok: false, status: 400, error: `"${label}" must be plain text, ${min}–${max} characters.` };
  return t;
};
/** Longer text: line breaks kept (at most two blank lines in a row), other control characters refused. */
const longText = (v: unknown, label: string, max: number): string | Fail => {
  if (typeof v !== 'string') return { ok: false, status: 400, error: `"${label}" must be text (0–${max} characters).` };
  const t = v.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/\n{4,}/g, '\n\n\n').trim();
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(t) || [...t].length > max) return { ok: false, status: 400, error: `"${label}" must be plain text, at most ${max} characters.` };
  return t;
};
const ATTACHMENT_ID = /^att_[a-z0-9]+$/;
const isColumn = (v: unknown): v is RoadmapColumn => typeof v === 'string' && (ROADMAP_COLUMNS as readonly string[]).includes(v);
const ownerOf = (v: unknown, names: readonly string[]): string | null | Fail => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !names.includes(v)) return { ok: false, status: 400, error: `"owner" must be a participant: ${names.join(', ')}.` };
  return v;
};

/** PUT …/pictures: {attachments: ["att_…"]}, the card's pictures in order: up to ROADMAP_PICTURES_MAX different ids. */
export function parsePictures(body: unknown): { ok: true; attachments: string[] } | Fail {
  const list = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).attachments : undefined;
  if (!Array.isArray(list) || list.length > ROADMAP_PICTURES_MAX || !list.every((a) => typeof a === 'string' && ATTACHMENT_ID.test(a)) || new Set(list).size !== list.length) {
    return { ok: false, status: 400, error: `Body must be {"attachments": [...]}: up to ${ROADMAP_PICTURES_MAX} different upload ids, in order.` };
  }
  return { ok: true, attachments: list as string[] };
}

/** POST: {column, title, note?, owner?, reviewer?, description?, attachments?: ["att_…"], top?: true}. */
export function parseNewItem(body: unknown, names: readonly string[]): { ok: true; column: RoadmapColumn; title: string; note: string; owner: string | null; description: string; attachments: string[]; top: boolean; reviewer: string | null } | Fail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Body must be {"column": "next", "title": "...", "note"?, "owner"?, "reviewer"?, "description"?, "attachments"?, "top"?}.' };
  const b = body as Record<string, unknown>;
  if (!isColumn(b.column)) return { ok: false, status: 400, error: `"column" must be one of ${ROADMAP_COLUMNS.join(', ')}.` };
  const title = line(b.title, 'title', 1, ROADMAP_TITLE_MAX);
  if (typeof title !== 'string') return title;
  const note = b.note === undefined ? '' : line(b.note, 'note', 0, ROADMAP_NOTE_MAX);
  if (typeof note !== 'string') return note;
  const owner = ownerOf(b.owner, names);
  if (owner !== null && typeof owner !== 'string') return owner;
  const description = b.description === undefined ? '' : longText(b.description, 'description', ROADMAP_DESCRIPTION_MAX);
  if (typeof description !== 'string') return description;
  const attachments = b.attachments === undefined ? [] : b.attachments;
  if (!Array.isArray(attachments) || attachments.length > ROADMAP_PICTURES_MAX || !attachments.every((a) => typeof a === 'string' && ATTACHMENT_ID.test(a)) || new Set(attachments).size !== attachments.length) {
    return { ok: false, status: 400, error: `"attachments" must be up to ${ROADMAP_PICTURES_MAX} different upload ids ("att_…" from POST /api/attachments).` };
  }
  if (b.top !== undefined && typeof b.top !== 'boolean') return { ok: false, status: 400, error: '"top" must be true or false.' };
  const reviewer = ownerOf(b.reviewer, names);
  if (reviewer !== null && typeof reviewer !== 'string') return { ...reviewer, error: reviewer.error.replace('"owner"', '"reviewer"') };
  return { ok: true, column: b.column, title, note, owner, description, attachments: attachments as string[], top: b.top === true, reviewer };
}

/** PATCH: any of {column, title, note, owner, description, reviewer}; at least one. */
export function parseItemChange(body: unknown, names: readonly string[]): { ok: true; change: Partial<Pick<RoadmapItem, 'column' | 'title' | 'note' | 'owner' | 'description' | 'reviewer'>> } | Fail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Body must be a JSON object with column, title, note or owner.' };
  const b = body as Record<string, unknown>;
  const change: Partial<Pick<RoadmapItem, 'column' | 'title' | 'note' | 'owner' | 'description' | 'reviewer'>> = {};
  if (b.column !== undefined) { if (!isColumn(b.column)) return { ok: false, status: 400, error: `"column" must be one of ${ROADMAP_COLUMNS.join(', ')}.` }; change.column = b.column; }
  if (b.title !== undefined) { const t = line(b.title, 'title', 1, ROADMAP_TITLE_MAX); if (typeof t !== 'string') return t; change.title = t; }
  if (b.note !== undefined) { const n = line(b.note, 'note', 0, ROADMAP_NOTE_MAX); if (typeof n !== 'string') return n; change.note = n; }
  if (b.owner !== undefined) { const o = ownerOf(b.owner, names); if (o !== null && typeof o !== 'string') return o; change.owner = o; }
  if (b.description !== undefined) { const d = longText(b.description, 'description', ROADMAP_DESCRIPTION_MAX); if (typeof d !== 'string') return d; change.description = d; }
  if (b.reviewer !== undefined) { const r = ownerOf(b.reviewer, names); if (r !== null && typeof r !== 'string') return { ...r, error: r.error.replace('"owner"', '"reviewer"') }; change.reviewer = r; }
  if (!Object.keys(change).length) return { ok: false, status: 400, error: 'Nothing to change: give column, title, note, owner, description or reviewer.' };
  return { ok: true, change };
}

/** PUT: {column, ids}: the new order of every card in that column. */
export function parseOrder(body: unknown): { ok: true; column: RoadmapColumn; ids: string[]; moved: string | null } | Fail {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!b || !isColumn(b.column) || !Array.isArray(b.ids) || !b.ids.every((id) => typeof id === 'string' && ROADMAP_ID.test(id)) || new Set(b.ids).size !== b.ids.length) {
    return { ok: false, status: 400, error: 'Body must be {"column": "next", "ids": ["rm_…", …]}: every card of that column once, in the new order.' };
  }
  // «moved»: the one card that was dragged (or moved with ↑ ↓), so only it counts as moved (migration 021).
  if (b.moved !== undefined && b.moved !== null && (typeof b.moved !== 'string' || !(b.ids as string[]).includes(b.moved))) {
    return { ok: false, status: 400, error: '"moved" must be one of the ids: the card that was dragged.' };
  }
  return { ok: true, column: b.column, ids: b.ids as string[], moved: typeof b.moved === 'string' ? b.moved : null };
}

/** Sorts cards by column (done, now, next, later), then by position. */
export function sortRoadmap(items: readonly RoadmapItem[]): RoadmapItem[] {
  return [...items].sort((a, b) => ROADMAP_COLUMNS.indexOf(a.column) - ROADMAP_COLUMNS.indexOf(b.column) || a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * A claim: {"note": "…"}, the line that says what the claimer found when looking first
 * («exists, small fix» or «new»). Optional; without it the card's note stays as it was.
 */
export function parseClaim(body: unknown): { ok: true; note: string | null } | Fail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Body must be a JSON object: {} or {"note": "exists, small fix"}.' };
  const raw = (body as { note?: unknown }).note;
  if (raw === undefined || raw === null) return { ok: true, note: null };
  const note = line(raw, 'note', 1, ROADMAP_NOTE_MAX);
  return typeof note === 'string' ? { ok: true, note } : note;
}

export type ClaimResult =
  | { status: 'ok'; item: RoadmapItem }
  | { status: 'taken'; owner: string; item: RoadmapItem }
  | { status: 'done'; item: RoadmapItem }
  /** The card changed under two tries in a row: nothing written, try again (Grok's nit on PR 78). */
  | { status: 'busy'; item: RoadmapItem }
  | { status: 'not_found' };

/**
 * PUT …/progress: {"progress": 0–100 or null, "status"?: "…"}. Without "status" the line stays as
 * it was (status null = keep); clearing the bar (progress null) clears the line too.
 */
export function parseProgress(body: unknown): { ok: true; progress: number | null; status: string | null } | Fail {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!b || !('progress' in b)) return { ok: false, status: 400, error: 'Body must be {"progress": 0–100 or null, "status": "short line"}.' };
  const p = b.progress;
  if (p !== null && (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100)) return { ok: false, status: 400, error: '"progress" must be a whole number 0–100, or null.' };
  const status = b.status === undefined ? (p === null ? '' : null) : line(b.status, 'status', 0, 80);
  if (status !== null && typeof status !== 'string') return status;
  return { ok: true, progress: p as number | null, status };
}

/** Where «Next» is cut by what we likely still finish today, and the numbers behind it. */
export interface TodayLine {
  /** How many cards at the top of «Next» are likely done today. */
  fits: number;
  /** Cards that reached «Done» today. */
  done: number;
  /** The working day so far, in hours (from 08:00 or the first change, whichever came first). */
  hours: number;
  /** Hours left until the end of the day. */
  left: number;
}

export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 19;

/**
 * The «likely today» line: today's pace (cards done per hour so far) times the hours left, less
 * the cards still in «Now» (they come first). Local time; null before the first card is done today,
 * since there is no pace yet. It counts cards, not positions, so reordering «Next» moves the line
 * with it: the card dragged above it pushes the last one below.
 */
export function todayLine(items: readonly RoadmapItem[], now: Date = new Date(), endHour = DAY_END_HOUR): TodayLine | null {
  const at = (h: number) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const midnight = at(0);
  const today = items.map((i) => ({ i, t: Date.parse(i.updated_at) })).filter((x) => x.t >= midnight && x.t <= now.getTime());
  const done = today.filter((x) => x.i.column === 'done').length;
  if (!done) return null;
  const start = Math.min(at(DAY_START_HOUR), ...today.map((x) => x.t));
  const hours = Math.max(1, (now.getTime() - start) / 3_600_000);
  const left = Math.max(0, (at(endHour) - now.getTime()) / 3_600_000);
  const inProgress = items.filter((i) => i.column === 'now').length;
  const fits = Math.max(0, Math.floor((done / hours) * left) - inProgress);
  return { fits, done, hours, left };
}

/** A card's LED, as in the work-in-flight strip: what state it is in, at a glance. */
export type CardTone = 'blocked' | 'review' | 'working' | 'stale';
export interface CardStatus { tone: CardTone; label: string }

/** Hours without a change after which a card in «Now» counts as stale (grey). */
export const CARD_STALE_HOURS = 3;

/**
 * The LED for a card, from its own words, so it needs nothing else to load:
 * - red, blinking: it waits on a human. A human owns it outside «Now» (it waits for their pick),
 *   or the note says «⛔ …», «waiting on David/the orchestrator/you»
 *   or starts with «David: …» / «Orchestrator: …» (the same «Name: step» as a flight).
 * - amber: «in review» (a pull request waits for the other agent).
 * - green: in «Now» with an owner, changed within the last CARD_STALE_HOURS.
 * - grey: in «Now», but no change for longer.
 * A human's own card in «Now» is work they are doing: green like anyone's. Done cards never have an
 * LED; queued cards in Next and Later have one only when they wait on a human.
 */
export function cardStatus(item: Pick<RoadmapItem, 'column' | 'note' | 'owner' | 'updated_at'>, now: number = Date.now(), humans: readonly string[] = ['david', 'orchestrator']): CardStatus | null {
  if (item.column === 'done') return null;
  const note = item.note.trim();
  const names = humans.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const human = item.column !== 'now' && item.owner !== null && humans.some((h) => h.toLowerCase() === item.owner!.toLowerCase());
  if (human || /⛔/.test(note) || new RegExp(`waiting on (the )?(${names}|you)\\b`, 'i').test(note) || new RegExp(`^@?(${names})\\s*:`, 'i').test(note)) return { tone: 'blocked', label: 'waiting on you' };
  if (/\bin review\b/i.test(note)) return { tone: 'review', label: 'in review' };
  if (item.column !== 'now' || !item.owner) return null;
  const hours = (now - Date.parse(item.updated_at)) / 3_600_000;
  return hours > CARD_STALE_HOURS ? { tone: 'stale', label: `no change for ${Math.floor(hours)} h` } : { tone: 'working', label: 'working' };
}

/**
 * Where to unblock a card: the first http(s) address in its note, when the card waits on a human
 * (cardStatus «blocked»). The roadmap shows it as a «Unblock →» button (playground #630).
 */
export function unblockHref(item: Pick<RoadmapItem, 'note'>, status: CardStatus | null): string | null {
  if (status?.tone !== 'blocked') return null;
  const m = /https?:\/\/[^\s<>«»"]+[^\s<>«»".,;:!?)]/.exec(item.note);
  return m ? m[0] : null;
}

/**
 * A card someone works on is in Now (house rule, playground #1081): a claim, or progress set on it,
 * moves a card from Next or Later to Now. Done stays Done, and a card already in Now stays where it is.
 * Clearing the progress (null) is no sign of work and moves nothing.
 */
export function movesToNow(item: Pick<RoadmapItem, 'column'>): boolean {
  return item.column === 'next' || item.column === 'later';
}
