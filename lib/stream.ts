// Live updates for the page (PLAN-v2.md, PR 3). One long response that pushes new messages and
// pin changes as they happen.
//
// There is no LISTEN/NOTIFY: the database is reached through Neon's pooler, which doesn't keep a
// session. Instead the stream asks the store once a second for a cheap fingerprint (newest id,
// pinned ids, poll tallies, reaction tallies, decision-card positions, read positions) and only reads messages when that changed. A vote, a reaction or a decision-card change re-sends only the message whose fingerprint entry changed. A moved read position is sent on its own, without re-sending messages. The stream ends itself well inside the
// function time limit, and the page reconnects from the last id it has.
import { MAIN_ROOM, type Message, type Sender } from './core';
import { SSE_PING, sseEvent } from './sse';
import type { Store } from './store';

/** Parse a reactions fingerprint (`count|latest|id:count:latest,...`) into message-id → entry. */
export function reactionEntriesInFingerprint(fp: string): Map<number, string> {
  const body = fp.split('|')[2] ?? '';
  const map = new Map<number, string>();
  if (!body) return map;
  for (const part of body.split(',')) {
    const id = Number(part.split(':', 1)[0]);
    if (Number.isInteger(id) && id > 0) map.set(id, part);
  }
  return map;
}

/** Message ids recorded in a reactions fingerprint. */
export function messageIdsInReactionsFingerprint(fp: string): number[] {
  return [...reactionEntriesInFingerprint(fp).keys()];
}

/**
 * Message ids whose reaction entry appeared, changed, or disappeared.
 * A disappeared id still has to be re-sent, so the client can clear the last reaction.
 */
export function reactionMessageIdsChanged(previous: string, next: string): number[] {
  const before = reactionEntriesInFingerprint(previous);
  const after = reactionEntriesInFingerprint(next);
  const ids = new Set<number>();
  for (const [id, entry] of after) {
    if (before.get(id) !== entry) ids.add(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export const INTERVAL_MS = 1_000;
export const HEARTBEAT_MS = 15_000;
export const MAX_STREAM_MS = 240_000; // 4 minutes; the route allows 5
const BATCH = 200;

/** Parse a polls fingerprint (`count|id:votes:latest,...`) into message-id → entry. */
export function pollEntriesInFingerprint(fingerprint: string): Map<number, string> {
  const pipe = fingerprint.indexOf('|');
  const entries = pipe === -1 ? '' : fingerprint.slice(pipe + 1);
  const map = new Map<number, string>();
  if (!entries) return map;
  for (const part of entries.split(',')) {
    const id = Number(part.split(':', 1)[0]);
    if (Number.isInteger(id) && id > 0) map.set(id, part);
  }
  return map;
}

/** Message ids whose poll entry appeared or changed (not merely arrived as a new last_id). */
export function pollMessageIdsChanged(previous: string, next: string): number[] {
  const before = pollEntriesInFingerprint(previous);
  const after = pollEntriesInFingerprint(next);
  const ids: number[] = [];
  for (const [id, entry] of after) {
    if (before.get(id) !== entry) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/** Parse a decisions fingerprint (`count|id:agree:object:latest,...`) into message-id → entry. */
export function decisionEntriesInFingerprint(fingerprint: string): Map<number, string> {
  return pollEntriesInFingerprint(fingerprint);
}

/**
 * Message ids whose decision-card entry appeared, changed, or disappeared.
 * A disappeared id still has to be re-sent, so the client can clear a withdrawn card.
 */
export function decisionMessageIdsChanged(previous: string, next: string): number[] {
  const before = decisionEntriesInFingerprint(previous);
  const after = decisionEntriesInFingerprint(next);
  const ids = new Set<number>();
  for (const [id, entry] of after) {
    if (before.get(id) !== entry) ids.add(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Parse a reads fingerprint (`count|name:upTo,name:upTo,...`) into participant → up_to. */
export function readEntriesInFingerprint(fp: string): Map<string, number> {
  const pipe = fp.indexOf('|');
  const entries = pipe === -1 ? '' : fp.slice(pipe + 1);
  const map = new Map<string, number>();
  if (!entries) return map;
  for (const part of entries.split(',')) {
    const cut = part.lastIndexOf(':');
    if (cut <= 0) continue;
    const name = part.slice(0, cut);
    const upTo = Number(part.slice(cut + 1));
    if (name && Number.isInteger(upTo) && upTo > 0) map.set(name, upTo);
  }
  return map;
}

/** Participant names whose read position appeared or moved forward. */
export function readParticipantsChanged(previous: string, next: string): string[] {
  const before = readEntriesInFingerprint(previous);
  const after = readEntriesInFingerprint(next);
  const names: string[] = [];
  for (const [name, upTo] of after) {
    if (before.get(name) !== upTo) names.push(name);
  }
  return names.sort();
}

export interface StreamOptions {
  store: Store;
  me: Sender;
  /** Last message id the client has. null: send the latest messages first, like GET /api/messages. */
  since: number | null;
  /** The room whose messages and pins are sent. Left out: `main`. */
  room?: string;
  /** What the client has seen, per room. With it, the `rooms` event says how many messages are unread in each. */
  seen?: Readonly<Record<string, number>>;
  signal?: AbortSignal;
  /** The id of the build this server runs, for the page to compare with its own. Left out of the event when not given. */
  build?: string;
  intervalMs?: number;
  heartbeatMs?: number;
  maxMs?: number;
  now?: () => number;
}

/**
 * Events, each with JSON data:
 *   hello     {"me": "david", "build": "…", "room": "main"}   once, first; "build" is the server's build id (lib/build.ts)
 *   messages  [Message, …]           new messages of the room, oldest first
 *   pins      [Message, …]           the full list of the room's pinned messages, at the start and on every change
 *   reads     [ReadPosition, …]      read positions: the full list at the start, then only the ones that moved
 *   rooms     [Room, …]              every room with its newest message id, at the start and whenever another room gets a message or a room is created
 *   bye       {"reason": "…"}        the server is ending the stream; reconnect with ?since=<last id>
 *   error     {"message": "…"}       something failed; the stream ends
 */
export function createEventStream(options: StreamOptions): ReadableStream<Uint8Array> {
  const { store, me, since, signal, build, seen } = options;
  const room = options.room ?? MAIN_ROOM;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const maxMs = options.maxMs ?? MAX_STREAM_MS;
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let onAbort: (() => void) | undefined;

  function stop() {
    closed = true;
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)); };
      const send = (event: string, data: unknown) => write(sseEvent(event, data));
      const end = () => {
        if (closed) return;
        stop();
        try { controller.close(); } catch { /* already closed by the client */ }
      };
      const fail = (e: unknown) => {
        console.error('[trialog] stream failed:', e instanceof Error ? e.message : e);
        send('error', { message: 'Server error. Reconnect in a moment.' });
        end();
      };
      onAbort = end;
      if (signal?.aborted) return end();
      signal?.addEventListener('abort', onAbort);

      let last = since ?? 0;
      let pins = '';
      let polls = '';
      let reactions = '';
      let decisions = '';
      let reads = '';
      let rooms = '';
      // The other rooms' part of the rooms fingerprint. A message in this room is sent as a message;
      // it needs no word about the rooms as well.
      const others = (fingerprint: string) => fingerprint.split(',').filter((entry) => !entry.startsWith(`${room}:`)).join(',');
      // A vote, a reaction or a position can be on a message in another room. This stream has one room.
      const mine = (messages: Message[]) => messages.filter((m) => m.room === room);
      const sendMessages = (messages: Message[]) => {
        if (!messages.length) return;
        last = messages[messages.length - 1].id;
        send('messages', messages);
      };

      try {
        send('hello', build === undefined ? { me, room } : { me, build, room });
        // Read the fingerprint before the lists: a change in between is then picked up by the first tick.
        const version = await store.version(room);
        pins = version.pins;
        polls = version.polls;
        reactions = version.reactions;
        decisions = version.decisions;
        reads = version.reads;
        rooms = others(version.rooms);
        sendMessages(await store.list({ since, room, limit: BATCH }));
        send('pins', await store.pinned(room));
        send('reads', await store.listReads());
        send('rooms', await store.listRooms({ seen, me }));
      } catch (e) {
        return fail(e);
      }

      const started = now();
      let lastWrite = now();
      const tick = async () => {
        if (closed) return;
        try {
          if (now() - started >= maxMs) {
            send('bye', { reason: 'time limit' });
            return end();
          }
          const version = await store.version(room);
          if (closed) return;
          let wrote = false;
          if (version.last_id > last) {
            sendMessages(await store.list({ since: last, room, limit: BATCH }));
            wrote = true;
          }
          if (version.pins !== pins) {
            pins = version.pins;
            send('pins', await store.pinned(room));
            wrote = true;
          }
          // A message in another room, or a new room: the page shows it on that room's tab.
          if (others(version.rooms) !== rooms) {
            rooms = others(version.rooms);
            send('rooms', await store.listRooms({ seen, me }));
            wrote = true;
          }
          // Vote and close changes do not move last_id, so they need their own fingerprint.
          // Re-send those messages without moving `last`, or a lower id would make the next tick replay the stream.
          if (version.polls !== polls) {
            const ids = pollMessageIdsChanged(polls, version.polls);
            polls = version.polls;
            if (ids.length) {
              const updated = mine(await store.listMessagesByIds(ids));
              if (updated.length) send('messages', updated);
            }
            wrote = true;
          }
          // Reaction changes do not move last_id, so they need their own fingerprint.
          // Re-send those messages without moving `last`, or a lower id would make the next tick replay the stream.
          if (version.reactions !== reactions) {
            const ids = reactionMessageIdsChanged(reactions, version.reactions);
            reactions = version.reactions;
            if (ids.length) {
              const updated = mine(await store.listMessagesByIds(ids));
              if (updated.length) send('messages', updated);
            }
            wrote = true;
          }
          // Decision-card changes do not move last_id, so they need their own fingerprint.
          // Re-send those messages without moving `last`, or a lower id would make the next tick replay the stream.
          if (version.decisions !== decisions) {
            const ids = decisionMessageIdsChanged(decisions, version.decisions);
            decisions = version.decisions;
            if (ids.length) {
              const updated = mine(await store.listMessagesByIds(ids));
              if (updated.length) send('messages', updated);
            }
            wrote = true;
          }
          // Read-position changes do not move last_id and are not part of a message, so they
          // have their own fingerprint. Only the positions that moved are sent.
          if (version.reads !== reads) {
            const names = readParticipantsChanged(reads, version.reads);
            reads = version.reads;
            if (names.length) {
              const listed = await store.listReads();
              const changed = listed.filter((r) => names.includes(r.participant));
              if (changed.length) send('reads', changed);
            }
            wrote = true;
          }
          if (wrote) lastWrite = now();
          else if (now() - lastWrite >= heartbeatMs) {
            write(SSE_PING);
            lastWrite = now();
          }
        } catch (e) {
          return fail(e);
        }
        if (!closed) timer = setTimeout(() => void tick(), intervalMs);
      };
      timer = setTimeout(() => void tick(), intervalMs);
    },
    cancel() {
      stop();
    },
  });
}
