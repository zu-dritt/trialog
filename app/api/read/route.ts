import { parseReadInput } from '../../../lib/core';
import { authenticate, error, json, readJson, roomError, safe } from '../../../lib/http';
import { ReadError, RoomError, getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_READ_BODY_BYTES = 4 * 1024;

// PUT /api/read {"upTo": 45, "room": "calm"}
// Sets the caller's read position, in the room of that message, to this message id if it is higher
// than the one they already have there. A lower id is accepted and left unchanged. The participant
// comes from the Bearer token. "room" is optional: the message says which room it is in. When it
// is given and the message is in another room, nothing is recorded (409).
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_READ_BODY_BYTES);
  if (bad) return bad;
  const input = parseReadInput(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  try {
    const read = await store.setReadPosition(me, input.upTo, input.room);
    return json({ read });
  } catch (e) {
    if (e instanceof ReadError) return error(404, e.message);
    if (e instanceof RoomError) return roomError(e);
    throw e;
  }
});
