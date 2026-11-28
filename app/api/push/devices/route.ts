import { MAX_BODY_BYTES } from '../../../../lib/core';
import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { parsePushDevice, parsePushToken, publicPushDevice } from '../../../../lib/push';
import { getStore } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/push/devices {"token","platform":"ios","env":"sandbox"|"production","bundle_id"?}
// Registers or updates the caller's device. The participant comes from the Bearer token.
// bundle_id is the APNs topic; when omitted, the hub stores the default (APNS_BUNDLE_ID, or
// dev.trialog.app). Re-registering refreshes last_seen_at and re-enables a disabled token.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const parsed = parsePushDevice(body);
  if (!parsed.ok) return error(400, parsed.error);
  const store = await getStore();
  const device = await store.upsertPushDevice({
    participant: me,
    token: parsed.token,
    platform: parsed.platform,
    env: parsed.env,
    bundle_id: parsed.bundle_id,
  });
  return json({ device: publicPushDevice(device) });
});

// DELETE /api/push/devices {"token"} — unregisters the caller's device with this token.
export const DELETE = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, MAX_BODY_BYTES);
  if (bad) return bad;
  const parsed = parsePushToken(body);
  if (!parsed.ok) return error(400, parsed.error);
  const store = await getStore();
  const deleted = await store.deletePushDevice(me, parsed.token);
  return json({ deleted });
});
