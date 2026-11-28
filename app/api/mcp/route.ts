import * as decisionRoute from '../decisions/[id]/route';
import * as flightRoute from '../flight/route';
import * as forYouRoute from '../for-you/route';
import * as messagesRoute from '../messages/route';
import * as roadmapRoute from '../roadmap/route';
import * as wakeRoute from '../wake/route';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { handleMcp, type HubCall, type RpcResponse } from '../../../lib/mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// wait_for_messages holds a request up to 25 seconds, as GET /api/wake does.
export const maxDuration = 60;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** The hub route a tool's call goes to, with its path parameters. Only these: the tools' own. */
function routeFor(method: string, path: string): { handler: Handler; params?: Record<string, string> } | null {
  const pathname = path.split('?')[0];
  const table: Record<string, Partial<Record<string, Handler>>> = {
    '/api/messages': messagesRoute as never,
    '/api/wake': wakeRoute as never,
    '/api/for-you': forYouRoute as never,
    '/api/roadmap': roadmapRoute as never,
    '/api/flight': flightRoute as never,
  };
  const direct = table[pathname]?.[method];
  if (direct) return { handler: direct };
  const decision = /^\/api\/decisions\/([^/]+)$/.exec(pathname);
  if (decision && method === 'PUT') return { handler: decisionRoute.PUT as unknown as Handler, params: { id: decodeURIComponent(decision[1]) } };
  return null;
}

// POST /api/mcp: the hub as an MCP server (lib/mcp.ts), «streamable HTTP» without sessions. One
// JSON-RPC message per request, answered with JSON; a notification gets 202 and no body. Sign in
// with the usual hub token: «Authorization: Bearer <token>». Each tool runs as the caller, through
// the same API route hub.js uses.
export const POST = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, 64 * 1024);
  if (bad) return bad;
  const auth = request.headers.get('authorization') ?? '';
  const origin = new URL(request.url).origin;
  const call: HubCall = async (method, path, payload) => {
    const route = routeFor(method, path);
    if (!route) return { status: 404, data: { error: `no such hub call: ${method} ${path}` } };
    const req = new Request(`${origin}${path}`, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: request.signal });
    const res = await route.handler(req, route.params ? { params: Promise.resolve(route.params) } : undefined);
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  if (Array.isArray(body)) {
    // Batches were taken out of MCP in 2025; older clients may still send one.
    const answers = (await Promise.all(body.map((m) => handleMcp(m, call)))).filter((a): a is RpcResponse => a !== null);
    return answers.length ? json(answers) : new Response(null, { status: 202 });
  }
  const answer = await handleMcp(body, call);
  return answer ? json(answer) : new Response(null, { status: 202 });
});

// No event stream and no sessions: a GET (to open one) or a DELETE (to end one) has nothing to do.
export const GET = safe(async () => error(405, 'This MCP server answers POST only: no event stream, no sessions.', { Allow: 'POST' }));
export const DELETE = GET;
