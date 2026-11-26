import { MAX_BODY_BYTES, parseRoomInput, parseSeen } from '../../../lib/core';
import { authenticate, error, json, readJson, roomError, safe } from '../../../lib/http';
import { RoomError, getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/rooms?seen=<room>:<id>,… → {me, rooms}: every room, `main` first, each with the id of
// its newest message. `seen` is optional: the id of the newest message the caller has seen, per
// room. With it, every room also says how many messages by others are newer than that ("unread";
// a room that is not named counts from the start).
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const seen = params.has('seen') ? parseSeen(params.get('seen') ?? '') : undefined;
  if (seen === null) return error(400, '"seen" must look like main:120,dev:45 (a room id and a message id each).');
  const store = await getStore();
  return json({ me, rooms: await store.listRooms({ seen, me }) });
});

// POST /api/rooms {"name": "Calm talk", "id": "calm"}
// Any participant may create a room. "id" is optional: without it, it is made from the name.
// A hub has at most 12 rooms. The creator is the owner of the Bearer token.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const input = parseRoomInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  try {
    return json({ room: await store.createRoom({ id: input.id, name: input.name, created_by: me }) }, 201);
  } catch (e) {
    if (e instanceof RoomError) return roomError(e);
    throw e;
  }
});
