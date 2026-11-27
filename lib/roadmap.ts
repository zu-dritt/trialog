// The roadmap: cards in four columns (done, now, next, later), in an order anyone can change. The
// orchestrator drags cards in «Next» and «Later» to say what matters most; the agents add, move and
// finish cards with hub.js. Stored in the hub (migrations/016-roadmap.sql).

export const ROADMAP_COLUMNS = ['done', 'now', 'next', 'later'] as const;
export type RoadmapColumn = (typeof ROADMAP_COLUMNS)[number];
export const ROADMAP_TITLE_MAX = 80;
export const ROADMAP_NOTE_MAX = 120;
export const ROADMAP_MAX_ITEMS = 200;
export const ROADMAP_ID = /^rm_[a-z0-9]{8,32}$/;

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
}

type Fail = { ok: false; status: number; error: string };

const line = (v: unknown, label: string, min: number, max: number): string | Fail => {
  if (typeof v !== 'string') return { ok: false, status: 400, error: `"${label}" must be text (${min}–${max} characters).` };
  const t = v.replace(/[\r\n\t]+/g, ' ').trim();
  if (/[\x00-\x1f\x7f]/.test(t) || [...t].length < min || [...t].length > max) return { ok: false, status: 400, error: `"${label}" must be plain text, ${min}–${max} characters.` };
  return t;
};
const isColumn = (v: unknown): v is RoadmapColumn => typeof v === 'string' && (ROADMAP_COLUMNS as readonly string[]).includes(v);
const ownerOf = (v: unknown, names: readonly string[]): string | null | Fail => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !names.includes(v)) return { ok: false, status: 400, error: `"owner" must be a participant: ${names.join(', ')}.` };
  return v;
};

/** POST: {column, title, note?, owner?}. */
export function parseNewItem(body: unknown, names: readonly string[]): { ok: true; column: RoadmapColumn; title: string; note: string; owner: string | null } | Fail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Body must be {"column": "next", "title": "...", "note": "...", "owner": "claude"}.' };
  const b = body as Record<string, unknown>;
  if (!isColumn(b.column)) return { ok: false, status: 400, error: `"column" must be one of ${ROADMAP_COLUMNS.join(', ')}.` };
  const title = line(b.title, 'title', 1, ROADMAP_TITLE_MAX);
  if (typeof title !== 'string') return title;
  const note = b.note === undefined ? '' : line(b.note, 'note', 0, ROADMAP_NOTE_MAX);
  if (typeof note !== 'string') return note;
  const owner = ownerOf(b.owner, names);
  if (owner !== null && typeof owner !== 'string') return owner;
  return { ok: true, column: b.column, title, note, owner };
}

/** PATCH: any of {column, title, note, owner}; at least one. */
export function parseItemChange(body: unknown, names: readonly string[]): { ok: true; change: Partial<Pick<RoadmapItem, 'column' | 'title' | 'note' | 'owner'>> } | Fail {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Body must be a JSON object with column, title, note or owner.' };
  const b = body as Record<string, unknown>;
  const change: Partial<Pick<RoadmapItem, 'column' | 'title' | 'note' | 'owner'>> = {};
  if (b.column !== undefined) { if (!isColumn(b.column)) return { ok: false, status: 400, error: `"column" must be one of ${ROADMAP_COLUMNS.join(', ')}.` }; change.column = b.column; }
  if (b.title !== undefined) { const t = line(b.title, 'title', 1, ROADMAP_TITLE_MAX); if (typeof t !== 'string') return t; change.title = t; }
  if (b.note !== undefined) { const n = line(b.note, 'note', 0, ROADMAP_NOTE_MAX); if (typeof n !== 'string') return n; change.note = n; }
  if (b.owner !== undefined) { const o = ownerOf(b.owner, names); if (o !== null && typeof o !== 'string') return o; change.owner = o; }
  if (!Object.keys(change).length) return { ok: false, status: 400, error: 'Nothing to change: give column, title, note or owner.' };
  return { ok: true, change };
}

/** PUT: {column, ids}: the new order of every card in that column. */
export function parseOrder(body: unknown): { ok: true; column: RoadmapColumn; ids: string[] } | Fail {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!b || !isColumn(b.column) || !Array.isArray(b.ids) || !b.ids.every((id) => typeof id === 'string' && ROADMAP_ID.test(id)) || new Set(b.ids).size !== b.ids.length) {
    return { ok: false, status: 400, error: 'Body must be {"column": "next", "ids": ["rm_…", …]}: every card of that column once, in the new order.' };
  }
  return { ok: true, column: b.column, ids: b.ids as string[] };
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
  | { status: 'not_found' };

/** {progress: 0–100 or null, status?: "…" (0–80)}: the owner's word on how far a card is. */
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
