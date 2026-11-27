// The work-in-flight strip: which state shows, how long, and what fits on a phone.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlightStrip, flightAge, flightLinkLabel, flightSentence, flightTone } from '../app/flight';
import type { Flight } from '../lib/shared';

const T = Date.parse('2026-11-27T08:00:00.000Z');
const ago = (min: number) => new Date(T - min * 60_000).toISOString();
const flight = (over: Partial<Flight>): Flight => ({ participant: 'claude', state: 'working', text: 'Journal 01', since: ago(5), updated_at: ago(1), last_message_at: ago(2), ...over });

test('working turns quiet only when both the flight and the last message are 20 minutes old', () => {
  assert.equal(flightTone(flight({}), T), 'working');
  assert.equal(flightTone(flight({ since: ago(30), last_message_at: ago(5) }), T), 'working', 'wrote recently');
  assert.equal(flightTone(flight({ since: ago(3), last_message_at: ago(90) }), T), 'working', 'just started');
  assert.equal(flightTone(flight({ since: ago(25), last_message_at: ago(21) }), T), 'quiet');
  assert.equal(flightTone(flight({ since: ago(25), last_message_at: null }), T), 'quiet', 'no message in a day');
  assert.equal(flightTone(flight({ state: 'waiting', since: ago(90), last_message_at: null }), T), 'waiting', 'waiting is never quiet');
  assert.equal(flightTone(flight({ state: 'idle', text: '' }), T), 'idle');
});

test('the age reads «now», «4 min», «1 h 05»', () => {
  assert.equal(flightAge(ago(0.5), T), 'now');
  assert.equal(flightAge(ago(4), T), '4 min');
  assert.equal(flightAge(ago(65), T), '1 h 05');
  assert.equal(flightAge(new Date(T + 60_000).toISOString(), T), 'now', 'a clock a little ahead is no negative age');
});

test('the strip: one entry per flight with its dot, name and words; the words hide on a phone', () => {
  const html = renderToStaticMarkup(<FlightStrip now={T} flights={[
    flight({}),
    flight({ participant: 'grok', state: 'waiting', text: 'review of PR 63', since: ago(4) }),
    flight({ participant: 'david', state: 'idle', text: '' }),
  ]} />);
  assert.match(html, /role="status" aria-label="Work in flight"/);
  assert.deepEqual([...html.matchAll(/data-flight="([a-z]+)"/g)].map((m) => m[1]), ['working', 'waiting', 'idle']);
  assert.match(html, /title="Claude: working on «Journal 01» · 5 min"/);
  assert.match(html, /waiting for «review of PR 63»/);
  assert.match(html, /max-sm:hidden/);
  assert.equal(renderToStaticMarkup(<FlightStrip now={T} flights={[]} />), '', 'nobody in flight: no strip');
});

test('a quiet flight says so', () => {
  assert.equal(flightSentence(flight({ since: ago(40), last_message_at: ago(30) }), T, 'Claude'), 'Claude: quiet, last on «Journal 01» · 40 min');
});

test('the page shows the strip once: under the header, or above the message box (never in split view)', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /<FlightBar token=\{token\} onUnauthorized=\{refuseToken\} participants=\{participants\} position=/);
  assert.match(page, /const flightAtBottom = flightPosition === 'bottom' && !splitVisible;/);
  assert.match(page, /\{flightAtBottom && flightBar\}/);
  assert.match(page, /\{!flightAtBottom && flightBar\}/);
});

test('«⇅» moves the strip; the choice is kept in this browser; the minutes are never cut off', async () => {
  const { readFlightPosition, writeFlightPosition, FLIGHT_POSITION_KEY } = await import('../app/flight');
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(readFlightPosition(storage), 'top');
  writeFlightPosition(storage, 'bottom');
  assert.equal(store.get(FLIGHT_POSITION_KEY), 'bottom');
  assert.equal(readFlightPosition(storage), 'bottom');
  assert.equal(readFlightPosition({ getItem: () => 'sideways' }), 'top');
  assert.equal(readFlightPosition({ getItem: () => { throw new Error('private mode'); } }), 'top');
  const html = renderToStaticMarkup(<FlightStrip now={T} flights={[flight({})]} position="bottom" onFlip={() => {}} />);
  assert.match(html, /data-position="bottom"[^>]*border-t/);
  assert.match(html, /aria-label="Move the work-in-flight strip to the top"[^>]*>⇅</);
  assert.match(html, /<span class="flex-none text-muted max-sm:hidden">· 5 min<\/span>/, 'the age sits outside the part that shortens');
  assert.ok(!renderToStaticMarkup(<FlightStrip now={T} flights={[flight({})]} />).includes('data-flip'), 'no ⇅ without a way to flip');
});

test('screen readers hear each whole sentence, also on a phone where the words are hidden', () => {
  const html = renderToStaticMarkup(<FlightStrip now={T} flights={[flight({ participant: 'grok', state: 'waiting', text: 'CI', since: ago(4) })]} />);
  assert.match(html, /<span class="sr-only">Grok: waiting for «CI» · 4 min<\/span><span aria-hidden="true" class="contents">/);
});

test('only the entries are the live region; «⇅» sits outside it and shows a focus ring', () => {
  const html = renderToStaticMarkup(<FlightStrip now={T} flights={[flight({})]} onFlip={() => {}} />);
  const live = /<div role="status" aria-label="Work in flight"[^>]*>([^]*?)<\/div><button/.exec(html);
  assert.ok(live, 'the button comes after the live region, not inside it');
  assert.match(html, /<button[^>]*focus-visible:outline-2[^>]*>⇅<\/button>/);
});

test('a human entry: red and blinking while an agent waits on them, grey otherwise', async () => {
  const { waitingOn, humanSentence } = await import('../app/flight');
  const P = [{ name: 'david', kind: 'human', label: 'Orchestrator', color: 'blue' }, { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' }, { name: 'grok', kind: 'agent', label: 'Grok', color: 'orange' }] as never;
  const human = { name: 'david', label: 'Orchestrator' };
  const flights = [
    flight({ participant: 'claude', state: 'waiting', text: 'David: merge PR 36' }),
    flight({ participant: 'grok', state: 'waiting', text: 'orchestrator:  go for the demo' }),
    flight({ participant: 'grok', state: 'waiting', text: 'review of PR 82' }),
    flight({ participant: 'claude', state: 'working', text: 'David: not a wait' }),
  ];
  assert.deepEqual(waitingOn(flights, human).map((w) => [w.by, w.text]), [['claude', 'merge PR 36'], ['grok', 'go for the demo']], 'by name or label, any case, only «waiting»');
  assert.deepEqual(waitingOn([flight({ participant: 'claude', state: 'waiting', text: 'review of PR 82' })], human), []);
  assert.equal(humanSentence('Orchestrator', [], P), 'Orchestrator: nothing waiting on you');
  assert.equal(humanSentence('Orchestrator', waitingOn(flights.slice(0, 1), human), P), 'Orchestrator: waiting on you (1): merge PR 36 (Claude)');
  const html = renderToStaticMarkup(<FlightStrip now={T} participants={P} flights={flights.slice(0, 1)} />);
  assert.match(html, /data-human="david" data-waiting=""/);
  assert.match(html, /blink-red/);
  assert.match(html, /waiting on you \(1\): merge PR 36/);
  const calm = renderToStaticMarkup(<FlightStrip now={T} participants={P} flights={[flight({})]} />);
  assert.match(calm, /data-human="david"/);
  assert.doesNotMatch(calm, /blink-red/);
  assert.match(calm, /nothing waiting on you/);
});

test('an address in a flight is a link: the waiting pill opens the right pull request, in any repo', () => {
  assert.equal(flightLinkLabel('https://github.com/amberleaf-gmbh/apartment-finder/pull/36', 'zu-dritt/trialog'), 'apartment-finder PR 36');
  assert.equal(flightLinkLabel('https://github.com/zu-dritt/trialog/pull/83', 'zu-dritt/trialog'), 'PR 83');
  const url = 'https://github.com/amberleaf-gmbh/apartment-finder/pull/36';
  const P = [{ name: 'david', kind: 'human', label: 'Orchestrator', color: 'blue' }, { name: 'claude', kind: 'agent', label: 'Claude', color: 'purple' }] as never;
  const html = renderToStaticMarkup(<FlightStrip now={T} participants={P} flights={[flight({ participant: 'claude', state: 'waiting', text: `David: merge ${url}.`, since: ago(2) })]} />);
  const human = html.slice(html.indexOf('data-human='), html.indexOf('data-flight='));
  assert.match(human, new RegExp(`<a href="${url}" target="_blank" rel="noopener noreferrer" title="${url}"[^>]*>apartment-finder PR 36</a>\\.`), 'a real link, the full sentence stop outside it');
  assert.doesNotMatch(human.slice(human.indexOf('<a ')), /aria-hidden/, 'the link is not hidden from screen readers');
  const agent = html.slice(html.indexOf('data-flight='));
  assert.match(agent, /<a href="https:\/\/github\.com\/amberleaf-gmbh\/apartment-finder\/pull\/36" tabindex="-1"/, 'in the agent’s own (hidden) text: clickable, not a tab stop');
});

test('«waiting for David: …» and «waiting on the orchestrator: …» count as waits on him; the pill does not cut a link on a phone', async () => {
  const { waitingOn } = await import('../app/flight');
  const human = { name: 'david', label: 'Orchestrator' };
  const f = (text: string) => ({ participant: 'claude', state: 'waiting', text, since: '2026-11-27T11:00:00Z' }) as Flight;
  assert.deepEqual(waitingOn([f('waiting for David: merge PR 37')], human).map((w) => w.text), ['merge PR 37']);
  assert.deepEqual(waitingOn([f('Waiting on Orchestrator: go for the demo')], human).map((w) => w.text), ['go for the demo']);
  assert.deepEqual(waitingOn([f('waiting for review: PR 87')], human), [], 'someone else');
  const src = readFileSync(new URL('../app/flight.tsx', import.meta.url), 'utf8');
  assert.match(src, /font-semibold text-\[#ff7b72\] sm:max-w-\[60ch\] sm:truncate/, 'truncated only from sm up');
  assert.match(src, /max-sm:w-\[calc\(100vw-4\.5rem\)\] max-sm:whitespace-normal/, 'on a phone a wait takes the width and wraps');
});
