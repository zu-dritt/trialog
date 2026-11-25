// Small helpers for the route handlers. Plain Web APIs only (Request/Response),
// so the handlers can be called directly from the tests.
import { senderFromAuth, type Sender } from './core';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...HEADERS, ...extra } });
}

export function error(status: number, message: string, extra?: Record<string, string>): Response {
  return json({ error: message }, status, extra);
}

/** Returns [sender, null] or [null, 401 Response]. */
export function authenticate(request: Request): [Sender, null] | [null, Response] {
  const sender = senderFromAuth(request.headers.get('authorization'));
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

/** Wraps a handler so unexpected failures return a JSON 500 instead of an HTML error page. */
export function safe<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (e) {
      console.error('[trialog]', e);
      return error(500, 'Server error. Check the Vercel function logs.');
    }
  };
}
