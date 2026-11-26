// Small helpers for the route handlers. Plain Web APIs only (Request/Response),
// so the handlers can be called directly from the tests.
import { senderFromAuth, type Sender } from './core';
import { ConfigError } from './participants';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...HEADERS, ...extra } });
}

export function error(status: number, message: string, extra?: Record<string, string>): Response {
  return json({ error: message }, status, extra);
}

/**
 * A setting that can't be used (lib/participants.ts). Until it is fixed nobody can be told apart,
 * so every request gets this answer, with or without a token. The message names the setting and
 * what is wrong with it, never a token.
 */
function misconfigured(e: ConfigError): Response {
  if (lastReported !== e.message) {
    lastReported = e.message; // once per problem, not once per request
    console.error(`[trialog] Configuration error: ${e.message}`);
  }
  return error(500, `Configuration error: ${e.message}`);
}
let lastReported = '';

/** Returns [sender, null] or [null, 401 Response], or [null, 500 Response] when the participants setting is broken. */
export function authenticate(request: Request): [Sender, null] | [null, Response] {
  let sender: Sender | null;
  try {
    sender = senderFromAuth(request.headers.get('authorization'));
  } catch (e) {
    if (e instanceof ConfigError) return [null, misconfigured(e)];
    throw e;
  }
  lastReported = ''; // the setting is usable (again): a later problem is logged afresh
  if (sender) return [sender, null];
  return [null, error(401, 'Missing or wrong token. Send "Authorization: Bearer <your token>".', { 'WWW-Authenticate': 'Bearer' })];
}

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
      if (e instanceof ConfigError) return misconfigured(e);
      console.error('[trialog]', e);
      return error(500, 'Server error. Check the Vercel function logs.');
    }
  };
}
