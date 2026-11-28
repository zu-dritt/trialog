// The health chips on the page: heartbeat colour, the word, the red blocked chip, the detail, and where they sit.
import { strict as assert } from 'node:assert';
import { renderToStaticMarkup } from 'react-dom/server';
import { test, vi } from 'vitest';
import type { AgentHealth, HealthReport } from '../lib/health';
import type { Participant } from '../lib/shared';

const FETCHED = Date.parse('2026-11-28T09:00:00.000Z');
const P: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0, label: 'Grok' },
  { name: 'claude', kind: 'agent', color: 1, label: 'Claude' },
  { name: 'david', kind: 'human', color: 2, label: 'Orchestrator' },
];
const agent = (over: Partial<AgentHealth>): AgentHealth => ({
  participant: 'claude', emoji: '🛠️', heard_at: '2026-11-28T08:58:00.000Z', heard_ago_ms: 120_000, heartbeat: 'green', word: 'building', state: 'working',
  text: 'iPhone app', blocked: null, last_merge: { pr: 133, merged_at: '2026-11-28T07:48:02.000Z' }, ...over,
});
const report = (...agents: AgentHealth[]): HealthReport => ({ now: new Date(FETCHED).toISOString(), agents });

async function load() {
  vi.stubEnv('TRIALOG_REPO', 'zu-dritt/trialog');
  vi.resetModules();
  return import('../app/health');
}

test('one chip per agent, in its colour, with the dot, the emoji and the word', async () => {
  const { HealthRow } = await load();
  const html = renderToStaticMarkup(<HealthRow report={report(agent({ participant: 'grok', emoji: '🔥', word: 'reviewing', text: 'Reviewing PR 140' }), agent({}))} fetchedAt={FETCHED} now={FETCHED} participants={P} />);
  assert.match(html, /role="group" aria-label="Agent health"/);
  assert.deepEqual([...html.matchAll(/data-health="([a-z]+)"/g)].map((m) => m[1]), ['grok', 'claude']);
  assert.match(html, /🔥/);
  assert.match(html, /🛠️/);
  assert.match(html, /reviewing/);
  assert.match(html, /color:#f0883e/, 'Grok in Grok\'s colour');
  assert.match(html, /color:#c792ea/, 'Claude in Claude\'s colour');
  assert.match(html, /aria-label="Grok: reviewing, heard 2 min ago"/);
  vi.unstubAllEnvs();
});

test('the dot moves on with the clock: green, amber at 10 minutes, grey at 20, without asking the hub again', async () => {
  const { HealthRow } = await load();
  const at = (minutes: number) => renderToStaticMarkup(<HealthRow report={report(agent({ heard_ago_ms: 60_000 }))} fetchedAt={FETCHED} now={FETCHED + minutes * 60_000} participants={P} />);
  assert.match(at(0), /data-heartbeat="green"/);
  assert.match(at(8), /data-heartbeat="green"/, '9 minutes since it was heard');
  assert.match(at(9), /data-heartbeat="amber"/, '10 minutes since it was heard');
  assert.match(at(18), /data-heartbeat="amber"/);
  assert.match(at(19), /data-heartbeat="grey"/, '20 minutes');
  assert.match(at(0), /health-beat/, 'green pulses');
  assert.doesNotMatch(at(19), /health-beat/, 'grey stands still');
  vi.unstubAllEnvs();
});

test('blocked: a red chip with ⛔ and the word «blocked», and the detail names who and what', async () => {
  const { HealthRow } = await load();
  const blocked = agent({ state: 'waiting', word: 'waiting', text: 'Orchestrator: merge PR 140', blocked: { on: 'Orchestrator', text: 'merge PR 140', since: '2026-11-28T08:55:00.000Z' } });
  const html = renderToStaticMarkup(<HealthRow report={report(blocked, agent({ participant: 'grok', emoji: '🔥' }))} fetchedAt={FETCHED} now={FETCHED} participants={P} />);
  const [claudeChip, grokChip] = html.split('data-health=').slice(1);
  assert.match(claudeChip, /data-blocked=""/);
  assert.match(claudeChip, /⛔/);
  assert.match(claudeChip, /<span class="font-semibold">blocked<\/span>/);
  assert.match(claudeChip, /border-bad/);
  assert.match(claudeChip, /data-blocked-on="">Blocked on Orchestrator: .*merge PR 140/);
  assert.doesNotMatch(grokChip, /data-blocked/);
  assert.doesNotMatch(grokChip, /border-bad/);
  vi.unstubAllEnvs();
});

test('the detail: «Claude · building «text» · last merge: PR 133, hh:mm», with the PR as a link', async () => {
  const { HealthRow, detailLine } = await load();
  const hhmm = (iso: string) => iso.slice(11, 16);
  assert.equal(detailLine(agent({}), 'Claude', hhmm), 'Claude · building «iPhone app» · last merge: PR 133, 07:48');
  assert.equal(detailLine(agent({ last_merge: null }), 'Claude', hhmm), 'Claude · building «iPhone app» · no merge of its own yet');
  assert.equal(detailLine(agent({ state: 'idle', word: 'resting', text: '' }), 'Grok', hhmm), 'Grok · resting · last merge: PR 133, 07:48');
  const html = renderToStaticMarkup(<HealthRow report={report(agent({}))} fetchedAt={FETCHED} now={FETCHED} participants={P} />);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /href="https:\/\/github\.com\/zu-dritt\/trialog\/pull\/133"[^>]*>PR 133<\/a>/);
  assert.match(html, /building «iPhone app»/);
  assert.match(html, /heard 2 min ago/);
  vi.unstubAllEnvs();
});

test('a silent agent: resting, grey, «not heard today»; nothing at all when there are no agents', async () => {
  const { HealthRow, heardText } = await load();
  assert.equal(heardText(null), 'not heard today');
  assert.equal(heardText(30_000), 'heard just now');
  assert.equal(heardText(49 * 60_000), 'heard 49 min ago');
  const silent = renderToStaticMarkup(<HealthRow report={report(agent({ participant: 'grok', emoji: '🔥', heard_at: null, heard_ago_ms: null, heartbeat: 'grey', word: 'resting', state: 'idle', text: '', last_merge: null }))} fetchedAt={FETCHED} now={FETCHED} participants={P} />);
  assert.match(silent, /data-heartbeat="grey"/);
  assert.match(silent, /not heard today/);
  assert.match(silent, /no merge of its own yet/);
  assert.equal(renderToStaticMarkup(<HealthRow report={report()} fetchedAt={FETCHED} now={FETCHED} participants={P} />), '');
  vi.unstubAllEnvs();
});

test('in the message box row the chips sit right after Guard, before Send, and take their own line on a phone', async () => {
  const { ComposerTools } = await import('../app/composer');
  const { HealthRow } = await load();
  const props = {
    to: '', onTo: () => {}, recipients: [], emoji: { open: false, onOpenChange: () => {}, onInsert: () => {}, boxRef: { current: null } },
    image: { disabled: false, onPick: () => {} }, decision: { open: false, onToggle: () => {} }, poll: { open: false, onToggle: () => {} },
    expand: { expanded: false, onToggle: () => {} }, send: { disabled: false, label: 'Send' }, fieldClassName: 'f', toolClassName: 't',
  };
  const chips = <HealthRow report={report(agent({}))} fetchedAt={FETCHED} now={FETCHED} participants={P} />;
  const row = renderToStaticMarkup(<ComposerTools {...props} guard={<i data-guard="" />} health={chips} />);
  assert.ok(row.indexOf('data-guard') < row.indexOf('data-health="claude"') && row.indexOf('data-health="claude"') < row.indexOf('>Send<'));
  assert.match(row, /max-sm:order-last max-sm:basis-full/);
  assert.doesNotMatch(row, />Enter sends/, 'the hint is not in the row any more…');
  assert.match(row, /title="Enter sends · Shift\+Enter for a new line"/, '…it is Send\'s tooltip');
  const plain = renderToStaticMarkup(<ComposerTools {...props} />);
  assert.match(plain, />Enter sends · Shift\+Enter for a new line</, 'without chips the row is as before');
  vi.unstubAllEnvs();
});
