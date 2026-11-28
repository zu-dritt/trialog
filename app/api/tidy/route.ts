import { authenticate, error, json, readJson, safe } from '../../../lib/http';
import { TIDY_PER_MINUTE, tidy, underLimit } from '../../../lib/tidy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** The hub can tidy only with an Anthropic API key in its settings (ANTHROPIC_API_KEY). */
const configured = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

// GET /api/tidy → {available}: whether the «✨ Tidy» button is offered.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  return json({ available: configured() });
});

// POST /api/tidy {"text"} → {text}: the message tidied by Claude Haiku 5.5 (lib/tidy.ts). Nothing is
// stored or sent. Each call logs its token counts, so the cost can be measured (hub decision 1420).
export const POST = safe(async (request: Request) => {
  const [me, denied] = authenticate(request);
  if (denied) return denied;
  if (!configured()) return error(503, 'Tidy is off: the hub has no Anthropic API key (ANTHROPIC_API_KEY).');
  const [body, bad] = await readJson(request, 40 * 1024);
  if (bad) return bad;
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') return error(400, 'Body must be {"text": "…"}.');
  if (!underLimit(me)) return error(429, `At most ${TIDY_PER_MINUTE} tidies a minute. Your text is unchanged.`, { 'Retry-After': '60' });
  const result = await tidy(text);
  if (!result.ok) return error(result.status, result.error);
  console.log(`[tidy] ${me} chars=${[...text].length} in=${result.usage.input_tokens} out=${result.usage.output_tokens}`);
  return json({ text: result.text });
});
