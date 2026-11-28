import { parseFlightInput } from '../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { notifyPushForFlight, schedulePush } from '../../../lib/push';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_FLIGHT_BODY_BYTES = 4 * 1024;

// GET /api/flight → everyone's work in flight: state, text, since, and when each last wrote.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  return json({ flights: await store.listFlights() });
});

// PUT /api/flight {"state": "working", "text": "Journal 01"} | {"state": "waiting", "text": "review of PR 62"} | {"state": "idle"}
// Sets the caller's own flight only (the participant comes from the Bearer token).
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_FLIGHT_BODY_BYTES);
  if (bad) return bad;
  const input = parseFlightInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  const before = (await store.listFlights()).find((f) => f.participant === me) ?? null;
  const flight = await store.setFlight({ participant: me, state: input.state, text: input.text });
  schedulePush(notifyPushForFlight(store, flight, before));
  return json({ flight });
});
