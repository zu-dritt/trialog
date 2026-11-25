// Live updates for the page (PLAN-v2.md, PR 3). One long response that pushes new messages and
// pin changes as they happen.
//
// There is no LISTEN/NOTIFY: the database is reached through Neon's pooler, which doesn't keep a
// session. Instead the stream asks the store once a second for a cheap fingerprint (newest id,
// pinned ids) and only reads messages when that changed. The stream ends itself well inside the
// function time limit, and the page reconnects from the last id it has.
import type { Message, Sender } from './core';
import { SSE_PING, sseEvent } from './sse';
import type { Store } from './store';

export const INTERVAL_MS = 1_000;
export const HEARTBEAT_MS = 15_000;
export const MAX_STREAM_MS = 240_000; // 4 minutes; the route allows 5
const BATCH = 200;

export interface StreamOptions {
  store: Store;
  me: Sender;
  /** Last message id the client has. null: send the latest messages first, like GET /api/messages. */
  since: number | null;
  signal?: AbortSignal;
  intervalMs?: number;
  heartbeatMs?: number;
  maxMs?: number;
  now?: () => number;
}

/**
 * Events, each with JSON data:
 *   hello     {"me": "david"}        once, first
 *   messages  [Message, …]           new messages, oldest first
 *   pins      [Message, …]           the full list of pinned messages, at the start and on every change
 *   bye       {"reason": "…"}        the server is ending the stream; reconnect with ?since=<last id>
 *   error     {"message": "…"}       something failed; the stream ends
 */
export function createEventStream(options: StreamOptions): ReadableStream<Uint8Array> {
  const { store, me, since, signal } = options;
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
      const sendMessages = (messages: Message[]) => {
        if (!messages.length) return;
        last = messages[messages.length - 1].id;
        send('messages', messages);
      };

      try {
        send('hello', { me });
        // Read the fingerprint before the lists: a change in between is then picked up by the first tick.
        const version = await store.version();
        pins = version.pins;
        sendMessages(await store.list({ since, limit: BATCH }));
        send('pins', await store.pinned());
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
          const version = await store.version();
          if (closed) return;
          let wrote = false;
          if (version.last_id > last) {
            sendMessages(await store.list({ since: last, limit: BATCH }));
            wrote = true;
          }
          if (version.pins !== pins) {
            pins = version.pins;
            send('pins', await store.pinned());
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
