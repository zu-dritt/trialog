// An agent's wait goes quiet by itself once the PRs it names are merged (David, playground #856:
// «Grok waiting for «PR 107 waiting on Claude»» after PR 107 was merged and live).
import { strict as assert } from 'node:assert';
import { renderToStaticMarkup } from 'react-dom/server';
import { test, vi } from 'vitest';
import type { Flight } from '../lib/shared';

const NOW = Date.parse('2026-11-27T20:40:00.000Z');
const flight = (text: string): Flight => ({ participant: 'grok', state: 'waiting', text, since: '2026-11-27T19:23:00.000Z', updated_at: '2026-11-27T19:23:00.000Z', last_message_at: null });
const P = [{ name: 'grok', kind: 'agent', label: 'Grok', color: 'orange' }, { name: 'david', kind: 'human', label: 'Orchestrator', color: 'blue' }] as never;

test('a wait on merged PRs shows grey «… merged»; an open one still says waiting', async () => {
  vi.stubEnv('TRIALOG_REPO', 'zu-dritt/trialog');
  vi.resetModules();
  const { FlightStrip } = await import('../app/flight');
  const merged = renderToStaticMarkup(<FlightStrip flights={[flight('PR 107 waiting on Claude')]} now={NOW} participants={P} merged={new Set([107])} />);
  assert.match(merged, /data-flight="idle"/);
  assert.match(merged, /data-merged=""/);
  assert.match(merged, /Grok: «PR 107 waiting on Claude» is merged/);
  const open = renderToStaticMarkup(<FlightStrip flights={[flight('PR 107 waiting on Claude')]} now={NOW} participants={P} merged={new Set([106])} />);
  assert.match(open, /data-flight="waiting"/);
  const noPr = renderToStaticMarkup(<FlightStrip flights={[flight('review of the plan')]} now={NOW} participants={P} merged={new Set([107])} />);
  assert.match(noPr, /data-flight="waiting"/, 'no PR named: unchanged');
  vi.unstubAllEnvs();
});
