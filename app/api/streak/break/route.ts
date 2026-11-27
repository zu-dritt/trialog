import { authenticate, error, json, readJson, safe } from '../../../../lib/http';
import { getStore } from '../../../../lib/store';
import { parseStreakBreak } from '../../../../lib/streak';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/streak/break {"reason": "a Vercel setting only the orchestrator can change"}
// Ends the streak. The orchestrator says «I stepped in»; an agent may end it too, honestly, when it
// needed the orchestrator to unblock something. The caller comes from the token, never the body.
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const [body, bad] = await readJson(request, 4 * 1024);
  if (bad) return bad;
  const input = parseStreakBreak(body);
  if (!input.ok) return error(input.status, input.error);
  const store = await getStore();
  return json({ break: await store.addStreakBreak({ participant: me, reason: input.reason }) });
});
