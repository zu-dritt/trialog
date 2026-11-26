import { BUILD_ID } from '../../../lib/build';
import { parseSince } from '../../../lib/core';
import { authenticate, error, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';
import { createEventStream } from '../../../lib/stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The stream ends itself after 4 minutes (MAX_STREAM_MS); this leaves a margin.
export const maxDuration = 300;

// GET /api/stream?since=<id> → text/event-stream with new messages and pin changes.
// Same Bearer token as every other endpoint. Without `since`, it starts with the latest messages.
// The events are described in lib/stream.ts.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const since = parseSince(new URL(request.url).searchParams.get('since'));
  if (since === undefined) return error(400, '"since" must be a message id (a whole number).');
  const store = await getStore();
  await store.ensure(); // fail with a JSON 500 here, before the stream starts, if the database is down
  return new Response(createEventStream({ store, me, since, signal: request.signal, build: BUILD_ID }), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
