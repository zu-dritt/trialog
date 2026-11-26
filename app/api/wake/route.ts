import { parseLimit, parseSince } from '../../../lib/core';
import { authenticate, error, json, roomFromQuery, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_WAIT_SECONDS = 25;

/** Parses ?wait=<seconds>, 0..25, default 0 (return immediately). */
function parseWait(value: string | null): number | undefined {
  if (value === null || value === '') return 0;
  if (!/^\d{1,2}$/.test(value)) return undefined;
  const n = Number(value);
  if (n > MAX_WAIT_SECONDS) return undefined;
  return n;
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// GET /api/wake?since=<id>&limit=<n>&wait=<seconds>&room=<id>
// Messages after `since` that should wake the caller (an agent), oldest first. Those of one room:
// `main` when none is named, like every other list, and every room with `room=all`.
// `untitled_pins` are pinned messages that still need a short title (not filtered by `since`).
// `wait` (0–25, default 0) holds the request until one arrives or the time runs out, then
// returns whatever is there (possibly none). Polling agents can keep using GET /api/messages?since=
// unchanged; this is the cheaper filter, and a short long-poll for a listener that cannot take
// an inbound request.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const since = parseSince(params.get('since'));
  if (since === undefined) return error(400, '"since" must be a message id (a whole number).');
  const limit = parseLimit(params.get('limit'));
  if (limit === undefined) return error(400, '"limit" must be a whole number.');
  const wait = parseWait(params.get('wait'));
  if (wait === undefined) return error(400, '"wait" must be a whole number of seconds, 0 to 25.');

  const { participants } = loadRoster();
  const humans = participants.filter((p) => p.kind === 'human').map((p) => p.name);
  const agents = participants.filter((p) => p.kind === 'agent').map((p) => p.name);
  const store = await getStore();
  const [room, noRoom] = await roomFromQuery(params, store);
  if (noRoom) return noRoom;

  const read = () => store.listWakingMessages({ participant: me, since, limit, humans, agents, room });
  let messages = await read();
  const deadline = Date.now() + wait * 1000;
  while (messages.length === 0 && Date.now() < deadline && !request.signal.aborted) {
    await pause(Math.min(1000, deadline - Date.now()), request.signal);
    if (request.signal.aborted) break;
    messages = await read();
  }
  // Untitled pins are not filtered by `since`, and they do not end a long-poll on their own
  // (a still-untitled pin would otherwise make every wait return at once).
  const untitled_pins = (await store.pinned(room)).filter((m) => !m.pin_title);
  return json({ me, messages, untitled_pins });
});
