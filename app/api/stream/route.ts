import { BUILD_ID } from '../../../lib/build';
import { parseSeen, parseSince } from '../../../lib/core';
import { authenticate, error, roomFromQuery, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';
import { createEventStream } from '../../../lib/stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The stream ends itself after 4 minutes (MAX_STREAM_MS); this leaves a margin.
export const maxDuration = 300;

// GET /api/stream?since=<id>&room=<id>&seen=<room>:<id>,… → text/event-stream with the new messages
// and pin changes of one room (without `room`: `main`), and the list of rooms whenever any room
// has news. `seen` is optional: with it, the list says how many messages are unread in each room.
// Same Bearer token as every other endpoint. Without `since`, it starts with the latest messages.
// The events are described in lib/stream.ts.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const since = parseSince(new URL(request.url).searchParams.get('since'));
  if (since === undefined) return error(400, '"since" must be a message id (a whole number).');
  const params = new URL(request.url).searchParams;
  const seen = params.has('seen') ? parseSeen(params.get('seen') ?? '') : undefined;
  if (seen === null) return error(400, '"seen" must look like main:120,dev:45 (a room id and a message id each).');
  const store = await getStore();
  await store.ensure(); // fail with a JSON 500 here, before the stream starts, if the database is down
  const [room, noRoom] = await roomFromQuery(params, store);
  if (noRoom) return noRoom;
  if (room === null) return error(400, 'The stream follows one room. Name it with "room", or leave "room" out for main.');
  return new Response(createEventStream({ store, me, since, room, seen, signal: request.signal, build: BUILD_ID }), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
