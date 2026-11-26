import { authenticate, json, safe } from '../../../lib/http';
import { displayName } from '../../../lib/shared';
import { loadRoster } from '../../../lib/participants';
import { getStore } from '../../../lib/store';
import { ENV_WAKE_PARTICIPANT, wakeTargetHost, webhookConfig } from '../../../lib/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/participants → who takes part here, in the order of the PARTICIPANTS setting, and who you are.
// {"me": "ana", "participants": [{"name": "ana", "kind": "human", "color": 0, "label": "Ana"}, …]}
// `color` is an index into the page's palette of twelve colours. `label` is how the participant is
// shown (the third part of their PARTICIPANTS entry, or the name with a capital); the name stays the
// id. Tokens are never part of the answer.
// A human also sees, for each participant, whether a wake-up target is set: the host only
// (`wake_target_host`) and when it was set (`wake_target_set_at`). Never the secret or the full URL.
export const GET = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const roster = loadRoster();
  const caller = roster.participants.find((p) => p.name === me);
  const base = roster.participants.map(({ name, kind, color, label }) => ({ name, kind, color, label: label ?? displayName(name) }));
  if (caller?.kind !== 'human') return json({ me, participants: base });

  const store = await getStore();
  const stored = await store.listWakeTargets();
  const byName = new Map(stored.map((t) => [t.participant, t]));
  const fallback = webhookConfig();
  if (fallback && roster.names.includes(ENV_WAKE_PARTICIPANT) && !byName.has(ENV_WAKE_PARTICIPANT)) {
    byName.set(ENV_WAKE_PARTICIPANT, { participant: ENV_WAKE_PARTICIPANT, url: fallback.url, updated_at: '' });
  }
  const participants = base.map((p) => {
    const target = byName.get(p.name);
    return {
      ...p,
      wake_target_host: target ? wakeTargetHost(target.url) || null : null,
      wake_target_set_at: target && target.updated_at ? target.updated_at : null,
    };
  });
  return json({ me, participants });
});
