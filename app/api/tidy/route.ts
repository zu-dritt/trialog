import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { loadRoster } from '../../../lib/participants';
import { TIDY_PER_MINUTE, TIDY_PROVIDERS, availableProviders, checkText, pickProvider, underLimit } from '../../../lib/tidy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function noKeyMessage(): string {
  const keys = TIDY_PROVIDERS.map((p) => p.keyEnv).join(', ');
  return `Tidy is off: the hub has no API key for it (${keys}).`;
}

// GET /api/tidy → {available, providers: [{id, label}]}: whether «✨ Tidy» is offered, and with which
// model makers (each one whose API key the hub has; playground #1440).
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const providers = availableProviders().map(({ id, label }) => ({ id, label }));
  return json({ available: providers.length > 0, providers });
});

// POST /api/tidy {"text", "provider"?} → {text, provider}: the message tidied by the chosen provider
// (lib/tidy.ts). Nothing is stored or sent. Each call logs the provider and its token counts, so
// the cost can be compared (hub decision 1420, #1440).
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  const available = availableProviders();
  if (!available.length) return error(503, noKeyMessage());
  const [body, badBody] = await readJson(request, 40 * 1024);
  if (badBody) return badBody;
  const { text, provider: asked } = (body ?? {}) as { text?: unknown; provider?: unknown };
  if (typeof text !== 'string') return error(400, 'Body must be {"text": "…", "provider"?: "anthropic"|"xai"}.');
  const provider = pickProvider(asked, available);
  if (!provider) return error(400, `"provider" must be one of: ${available.map((p) => p.id).join(', ')}.`);
  if (!underLimit(me)) return error(429, `At most ${TIDY_PER_MINUTE} tidies a minute. Your text is unchanged.`, { 'Retry-After': '60' });
  const bad = checkText(text);
  if (bad) return error(bad.status, bad.error);
  // The team's names and labels, so a misheard name can be put right (playground #1455).
  const names = loadRoster().participants.flatMap((p) => [p.label ?? '', p.name]);
  const result = await provider.run(text, names);
  if (!result.ok) return error(result.status, result.error);
  console.log(`[tidy] ${me} provider=${provider.id} chars=${[...text].length} in=${result.usage.input_tokens} out=${result.usage.output_tokens}`);
  return json({ text: result.text, provider: provider.id });
});
