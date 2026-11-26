import { RATE_LIMIT_PER_MIN, parseSince } from '../../../../../../lib/core';
import { authenticate, error, json, safe } from '../../../../../../lib/http';
import { getStore } from '../../../../../../lib/store';
import { canonicalEmoji } from '../../../../../emoji-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function decodeParam(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function parseTarget(params: Promise<{ id: string; emoji: string }>):
  Promise<{ ok: true; messageId: number; emoji: string } | { ok: false; error: string }> {
  const { id, emoji: raw } = await params;
  const messageId = parseSince(id);
  if (messageId === null || messageId === undefined) return { ok: false, error: 'Message id must be a whole number.' };
  const emoji = canonicalEmoji(decodeParam(raw));
  if (!emoji) return { ok: false, error: 'That emoji is not in the allow-list (the same list the picker uses).' };
  return { ok: true, messageId, emoji };
}

// PUT /api/messages/<id>/reactions/<emoji>
// The participant always comes from the Bearer token; any "participant" in a body is ignored.
// A reaction never wakes anyone and never pins the message.
export const PUT = safe(async (request: Request, { params }: { params: Promise<{ id: string; emoji: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const target = await parseTarget(params);
  if (!target.ok) return error(400, target.error);
  const result = await (await getStore()).addReaction(target.messageId, me, target.emoji);
  if (result.status === 'not_found') return error(404, `No message #${target.messageId}.`);
  if (result.status === 'rate_limited') {
    return error(429, `Rate limit: at most ${RATE_LIMIT_PER_MIN} reactions per minute per sender. Wait a moment.`, { 'Retry-After': '60' });
  }
  return json({ message: result.message });
});

// DELETE /api/messages/<id>/reactions/<emoji>
export const DELETE = safe(async (request: Request, { params }: { params: Promise<{ id: string; emoji: string }> }) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const target = await parseTarget(params);
  if (!target.ok) return error(400, target.error);
  const message = await (await getStore()).removeReaction(target.messageId, me, target.emoji);
  if (!message) return error(404, `No message #${target.messageId}.`);
  return json({ message });
});
