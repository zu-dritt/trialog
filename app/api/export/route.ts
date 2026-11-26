import { toMarkdown } from '../../../lib/core';
import { MAIN_ROOM } from '../../../lib/core';
import { MAIN, authenticate, roomFromQuery, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/export?room=<id> → the whole transcript of one room as Markdown. Without `room`: `main`.
// `room=all`: every room in one transcript, in the order the messages were written.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const [id, noRoom] = await roomFromQuery(new URL(request.url).searchParams, store);
  if (noRoom) return noRoom;
  const room = id === null ? 'all' : id === MAIN_ROOM ? MAIN : (await store.getRoom(id)) ?? MAIN;
  const date = new Date().toISOString().slice(0, 10);
  // The file of `main` is named as it always was; another room's carries the room's id.
  const name = id === MAIN_ROOM ? `trialog-${date}.md` : `trialog-${id ?? 'all'}-${date}.md`;
  return new Response(toMarkdown(await store.all(id), new Date(), room), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
});
