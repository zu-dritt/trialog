import { MAX_BODY_BYTES } from '../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { loadRoster } from '../../../../lib/participants';
import { getStore } from '../../../../lib/store';
import { assertPublicWakeUrl, parseWakeTarget, wakeTargetHost } from '../../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function publicTarget(target: { url: string; updated_at: string }) {
  return { host: wakeTargetHost(target.url), updated_at: target.updated_at };
}

// GET /api/wake/target — the caller's registered host, never the secret or the full URL.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const target = await store.getWakeTarget(me);
  if (!target) return error(404, 'No wake-up target is set.');
  return json({ target: publicTarget(target) });
});

// PUT /api/wake/target {"url": "https://…", "secret": "…"}
// Sets or replaces the caller's own target. The secret is stored for signing and is never returned.
// Internal hosts (and names that resolve to one) are refused.
export const PUT = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const parsed = parseWakeTarget((body ?? {}) as { url?: unknown; secret?: unknown });
  if (!parsed.ok) return error(400, parsed.error);
  const allowed = await assertPublicWakeUrl(parsed.target.url);
  if (!allowed.ok) return error(400, allowed.error);
  const store = await getStore();
  const target = await store.setWakeTarget(me, parsed.target.url, parsed.target.secret);
  return json({ target: publicTarget(target) });
});

// DELETE /api/wake/target — drops the caller's target.
// DELETE /api/wake/target?participant=<name> — a human can clear any participant's target.
export const DELETE = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const roster = loadRoster();
  const requested = new URL(request.url).searchParams.get('participant');
  let who = me;
  if (requested !== null && requested !== '') {
    const name = requested.trim().replace(/^@/, '').toLowerCase();
    const caller = roster.participants.find((p) => p.name === me);
    if (caller?.kind !== 'human') return error(403, 'Only a human can clear another participant\'s wake-up target.');
    if (!roster.names.includes(name)) return error(404, 'That participant is not on this hub.');
    who = name;
  }
  const store = await getStore();
  const cleared = await store.clearWakeTarget(who);
  return json({ cleared });
});
