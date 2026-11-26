'use client';

// Rooms on the page: the tabs in the header, the room in the address, and what this browser has
// seen in each room.
//
// One room is open at a time. Its tab is marked; every other tab shows how many messages by
// others arrived there since this browser last had that room open. That is kept in this browser,
// per participant, and never leaves it except as the "seen" list the page sends when it asks for
// the counts. The address carries the room (`?room=calm`), so a reload and a shared link land in
// the right one; `main` needs nothing in the address.
import { useEffect, useRef, useState } from 'react';
import { MAIN_ROOM, RESERVED_ROOM_IDS, ROOM_ID_PATTERN, ROOM_NAME_MAX_LENGTH, cleanRoomName, roomIdFromName, type Room } from '../lib/shared';

// --- the room in the address ------------------------------------------------------------------

/** The room an address names with `?room=`, or `main`. Anything that can't be a room id counts as none. */
export function roomFromSearch(search: string): string {
  const id = new URLSearchParams(search).get('room');
  return id && ROOM_ID_PATTERN.test(id) ? id : MAIN_ROOM;
}

/** The same address for another room: `?room=<id>` is set, and removed for `main`. The rest stays. */
export function addressForRoom(href: string, room: string): string {
  const url = new URL(href);
  if (room === MAIN_ROOM) url.searchParams.delete('room');
  else url.searchParams.set('room', room);
  return `${url.pathname}${url.search}${url.hash}`;
}

// --- what this browser has seen ---------------------------------------------------------------

/** One entry per participant, so a second person at the same browser has their own counts. */
export const seenKey = (participant: string): string => `trialogSeen:${participant}`;

type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type Seen = Record<string, number>;

/** The id of the newest message seen in each room. Never throws: storage can be switched off or hold anything. */
export function readSeen(storage: SeenStorage, participant: string): Seen {
  try {
    const kept = JSON.parse(storage.getItem(seenKey(participant)) ?? '{}') as unknown;
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return {};
    const seen: Seen = {};
    for (const [room, id] of Object.entries(kept)) {
      if (ROOM_ID_PATTERN.test(room) && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) seen[room] = id;
    }
    return seen;
  } catch {
    return {};
  }
}

/** `seen` with message `id` seen in `room`. The same object when that is nothing new. */
export function withSeen(seen: Seen, room: string, id: number): Seen {
  return id > (seen[room] ?? 0) ? { ...seen, [room]: id } : seen;
}

export function writeSeen(storage: SeenStorage, participant: string, seen: Seen): void {
  try {
    storage.setItem(seenKey(participant), JSON.stringify(seen));
  } catch { /* storage is full or off: the counts then start again after a reload */ }
}

// --- the tabs ---------------------------------------------------------------------------------

/** What a tab's count shows: nothing for none, the number, and "99+" beyond that. */
export const unreadLabel = (unread: number | undefined): string => (!unread || unread < 1 ? '' : unread > 99 ? '99+' : String(unread));

/** What a screen reader hears for a tab. */
export function tabLabel(room: Pick<Room, 'name' | 'unread'>, current: boolean): string {
  if (current) return `${room.name}, the room that is open`;
  const n = room.unread ?? 0;
  return n > 0 ? `${room.name}, ${n > 99 ? 'more than 99' : n} new ${n === 1 ? 'message' : 'messages'}` : room.name;
}

/** Why a name can't be used for a new room, or '' when it can. */
export function roomNameProblem(name: string, rooms: readonly Pick<Room, 'id'>[]): string {
  if (name.trim() === '') return '';
  if (!cleanRoomName(name)) return `A room name has at most ${ROOM_NAME_MAX_LENGTH} characters.`;
  const id = roomIdFromName(name);
  if (!id) return 'The name needs at least one letter from a to z.';
  if (RESERVED_ROOM_IDS.includes(id)) return `"${id}" can't be the id of a room. Try another name.`;
  if (rooms.some((r) => r.id === id)) return `There is a room "${id}" already.`;
  return '';
}

const TAB = 'flex flex-none cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[13px] whitespace-nowrap';

/**
 * The row of tabs: one per room, the open one marked, and a "+" that opens a small form for a new
 * room. The tabs scroll sideways when they don't fit, as they won't on a phone.
 *   onCreate  creates the room and resolves to '' when that worked, or to what went wrong
 */
export function RoomTabs({ rooms, current, onPick, onCreate, canCreate = true, className = '' }: {
  rooms: readonly Room[];
  current: string;
  onPick: (id: string) => void;
  onCreate: (name: string) => Promise<string>;
  /** False when the hub has all the rooms it can have. */
  canCreate?: boolean;
  className?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const strip = useRef<HTMLElement>(null);
  useEffect(() => { if (adding) field.current?.focus(); }, [adding]);
  // The open room's tab is in view, also after a reload in a room far to the right.
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current, rooms.length]);

  const problem = failure || roomNameProblem(name, rooms);
  const id = roomIdFromName(name);
  const close = () => { setAdding(false); setName(''); setFailure(''); };
  const submit = async () => {
    const clean = cleanRoomName(name);
    if (!clean || roomNameProblem(name, rooms) || busy) return;
    setBusy(true);
    setFailure('');
    const wrong = await onCreate(clean);
    setBusy(false);
    if (wrong) setFailure(wrong);
    else close();
  };

  return (
    // The strip of tabs scrolls sideways when they don't fit. The "+" stands outside it, so it is
    // always in reach, and the form for a new room opens under the row, where it takes no room from it.
    <div className={`relative min-w-0 items-center gap-1.5 ${className}`}>
      <nav ref={strip} aria-label="Rooms" className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rooms.map((room) => {
          const open = room.id === current;
          const count = open ? '' : unreadLabel(room.unread);
          return (
            <button
              key={room.id} type="button" aria-current={open ? 'page' : undefined} aria-label={tabLabel(room, open)} title={`Room ${room.id}`}
              onClick={() => { if (!open) onPick(room.id); }}
              className={`${TAB} ${open ? 'border-accent bg-panel font-semibold text-fg' : 'border-line bg-transparent text-muted hover:text-fg'}`}
            >
              <span aria-hidden="true">{room.name}</span>
              {count && <span aria-hidden="true" className="rounded-full bg-accent px-1.5 text-[11px] font-bold leading-[1.5] text-bg">{count}</span>}
            </button>
          );
        })}
      </nav>
      <button
        type="button" disabled={!canCreate} onClick={() => (adding ? close() : setAdding(true))}
        aria-label="New room" aria-expanded={adding} title={canCreate ? 'New room' : 'This hub has all the rooms it can have.'}
        className={`${TAB} border-dashed border-line bg-transparent text-muted hover:text-fg disabled:cursor-default disabled:opacity-50`}
      >+</button>
      {adding && (
        <form
          className="absolute left-0 top-full z-40 mt-1.5 flex w-[min(300px,calc(100vw-2rem))] flex-col gap-1.5 rounded-md border border-line bg-panel p-2.5 shadow-lg shadow-black/50"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
        >
          <input
            ref={field} value={name} maxLength={ROOM_NAME_MAX_LENGTH} placeholder="Name of the new room" aria-label="Name of the new room" autoComplete="off"
            aria-invalid={problem ? true : undefined}
            onChange={(e) => { setName(e.target.value); setFailure(''); }}
            className="w-full rounded-md border border-line bg-bg px-2 py-[5px] text-[13px] placeholder:text-muted"
          />
          {/* What the room will be called in addresses and on the command line, or why the name can't be used. */}
          <span role="status" className={`min-h-[1.5em] text-xs ${problem ? 'text-bad' : 'text-muted'}`}>{problem || (id ? `Its id will be ${id}.` : 'Every participant sees every room.')}</span>
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={close} className={`${TAB} border-line bg-transparent text-muted hover:text-fg`}>Cancel</button>
            <button type="submit" disabled={busy || !id || Boolean(roomNameProblem(name, rooms))} className={`${TAB} border-line bg-[#2a2f3a] hover:bg-[#343a47] disabled:cursor-default disabled:opacity-50`}>{busy ? 'Creating…' : 'Create room'}</button>
          </div>
        </form>
      )}
    </div>
  );
}
