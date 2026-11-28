import { authenticate, safe } from '../../../../lib/http';
import { getStore } from '../../../../lib/store';
import { createRoadmapStream } from '../../../../lib/stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The stream ends itself after 4 minutes (MAX_STREAM_MS); this leaves a margin.
export const maxDuration = 300;

// GET /api/roadmap/stream → text/event-stream: every card at the start, then again after every
// change (a new, moved, edited or removed card). Same Bearer token as every other endpoint. The
// events are described in lib/stream.ts (createRoadmapStream).
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  await store.ensure(); // fail with a JSON 500 here, before the stream starts, if the database is down
  return new Response(createRoadmapStream({ store, signal: request.signal }), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
