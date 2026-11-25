import { toMarkdown } from '../../../lib/core';
import { authenticate, safe } from '../../../lib/http';
import { getStore } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/export → the whole transcript as Markdown.
export const GET = safe(async (request: Request) => {
  const [, denied] = authenticate(request);
  if (denied) return denied;
  const store = await getStore();
  const date = new Date().toISOString().slice(0, 10);
  return new Response(toMarkdown(await store.all()), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="trialog-${date}.md"`,
      'Cache-Control': 'no-store',
    },
  });
});
