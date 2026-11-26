// Split view: two rooms side by side in one window. Off by default; the choice is kept in this
// browser, per participant. Below SPLIT_MIN_WIDTH_PX the page shows one pane, and the stored
// choice is left as it is, so a wider window brings the second pane back.

import { MAIN_ROOM, ROOM_ID_PATTERN } from '../lib/shared';

export const SPLIT_MIN_WIDTH_PX = 1024;

export const splitKey = (participant: string): string => `trialogSplit:${participant}`;

export type SplitPref = { open: boolean; room: string };

type SplitStorage = Pick<Storage, 'getItem' | 'setItem'>;

const empty: SplitPref = { open: false, room: MAIN_ROOM };

/** The stored split choice, or off with Main in the second pane. Never throws. */
export function readSplit(storage: SplitStorage, participant: string): SplitPref {
  try {
    const raw = storage.getItem(splitKey(participant));
    if (!raw) return empty;
    const kept = JSON.parse(raw) as unknown;
    if (!kept || typeof kept !== 'object') return empty;
    const rec = kept as Record<string, unknown>;
    const room = typeof rec.room === 'string' && ROOM_ID_PATTERN.test(rec.room) ? rec.room : MAIN_ROOM;
    return { open: rec.open === true, room };
  } catch {
    return empty;
  }
}

/** Writes the split choice. A failure (storage off or full) is ignored. */
export function writeSplit(storage: SplitStorage, participant: string, pref: SplitPref): void {
  try {
    storage.setItem(splitKey(participant), JSON.stringify({ open: pref.open, room: pref.room }));
  } catch { /* the toggle still works for this visit */ }
}

/** The first room that is not `primary`, or Main when there is no other. */
export function defaultSecondRoom(rooms: readonly { id: string }[], primary: string): string {
  return rooms.find((r) => r.id !== primary)?.id ?? MAIN_ROOM;
}

/** Whether two panes fit: the same threshold as the `lg` layout (1024px). */
export function splitFits(width: number): boolean {
  return width >= SPLIT_MIN_WIDTH_PX;
}
