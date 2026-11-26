// Small helpers for the route handlers. Plain Web APIs only (Request/Response),
// so the handlers can be called directly from the tests.
import { ALL_ROOMS, MAIN_ROOM, ROOM_ID_HINT, parseRoomId, senderFromAuth, type Room, type Sender } from './core';
import { ConfigError, holdsListedToken } from './participants';
import { RoomError, type Store } from './store';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...HEADERS, ...extra } });
}

export function error(status: number, message: string, extra?: Record<string, string>): Response {
  return json({ error: message }, status, extra);
}

/** What a caller without a participant's token is told when the participants setting is broken: that, and no more. */
export const MISCONFIGURED = 'Configuration error. The details are in the server log.';

/**
 * A setting that can't be used (lib/participants.ts). Until it is fixed nobody can post or read,
 * so every request answers 500. What is wrong (which entry, which token variable) is written to
 * the server log. A caller who holds the token of someone on the list is told as well, so the page
 * and the command line can show it to a participant. Anyone else, with a wrong token or none, gets
 * a 500 that names nothing. No answer and no log line ever holds a token.
 */
function misconfigured(e: ConfigError, request?: unknown): Response {
  if (lastReported !== e.message) {
    lastReported = e.message; // once per problem, not once per request
    console.error(`[trialog] Configuration error: ${e.message}`);
  }
  const insider = request instanceof Request && holdsListedToken(request.headers.get('authorization'));
  return error(500, insider ? `Configuration error: ${e.message}` : MISCONFIGURED);
}
let lastReported = '';

/** Returns [sender, null] or [null, 401 Response], or [null, 500 Response] when the participants setting is broken (see misconfigured). */
export function authenticate(request: Request): [Sender, null] | [null, Response] {
  let sender: Sender | null;
  try {
    sender = senderFromAuth(request.headers.get('authorization'));
  } catch (e) {
    if (e instanceof ConfigError) return [null, misconfigured(e, request)];
    throw e;
  }
  lastReported = ''; // the setting is usable (again): a later problem is logged afresh
  if (sender) return [sender, null];
  return [null, error(401, 'Missing or wrong token. Send "Authorization: Bearer <your token>".', { 'WWW-Authenticate': 'Bearer' })];
}

/**
 * The room a query names with `?room=<id>`, as [room, null]; null stands for every room, which a
 * reader asks for with `?room=all`. Without `room` it is `fallback`: `main` for most calls, so a
 * client from before rooms keeps working. [null, error Response] when the value can't be a room
 * id (400) or no such room exists (404).
 */
export async function roomFromQuery(params: URLSearchParams, store: Store, fallback: string | null = MAIN_ROOM): Promise<[string | null, null] | [null, Response]> {
  const id = parseRoomId(params.get('room'));
  if (id === undefined) return [null, error(400, ROOM_ID_HINT)];
  if (id === null) return [fallback, null];
  if (id === ALL_ROOMS) return [null, null];
  if (id !== MAIN_ROOM && !(await store.getRoom(id))) return [null, roomError(new RoomError('not found', id))];
  return [id, null];
}

/** A room that can't be used or created, as an answer: 404 when it does not exist, 409 otherwise. */
export function roomError(e: RoomError): Response {
  return error(e.reason === 'not found' ? 404 : 409, e.message);
}

/** What `main` is when the store is not asked: its id and name, for the title of an export. */
export const MAIN: Pick<Room, 'id' | 'name'> = { id: MAIN_ROOM, name: 'Main' };

/** Reads a JSON body of at most maxBytes. Returns [body, null] or [null, error Response]. */
export async function readJson(request: Request, maxBytes: number): Promise<[unknown, null] | [null, Response]> {
  const tooLarge = () => error(413, `Request body is larger than ${Math.round(maxBytes / 1024)} KB.`);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) return [null, tooLarge()];
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return [null, tooLarge()];
  try {
    return [JSON.parse(raw) as unknown, null];
  } catch {
    return [null, error(400, 'Body is not valid JSON.')];
  }
}

/**
 * Reads a raw body of at most maxBytes, and stops reading as soon as it is over.
 * Returns [bytes, null] or [null, 413 Response].
 */
export async function readBytes(request: Request, maxBytes: number, tooLarge: string): Promise<[Buffer, null] | [null, Response]> {
  // A declared length is only a first check; the bytes are counted as they arrive.
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return [null, error(413, tooLarge)];
  if (!request.body) return [Buffer.alloc(0), null];
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return [null, error(413, tooLarge)];
    }
    chunks.push(value);
  }
  return [Buffer.concat(chunks), null];
}

/** Wraps a handler so unexpected failures return a JSON 500 instead of an HTML error page. */
export function safe<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof ConfigError) return misconfigured(e, args[0]);
      // Only what identifies the failure. A database error's detail can quote the row it refused,
      // and a row may hold a secret.
      const code = typeof e === 'object' && e !== null && 'code' in e ? ` (${String((e as { code: unknown }).code)})` : '';
      console.error(`[trialog] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}${code}`);
      return error(500, 'Server error. Check the Vercel function logs.');
    }
  };
}
