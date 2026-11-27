// The work-in-flight strip: which state shows, how long, and what fits on a phone.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlightStrip, flightAge, flightSentence, flightTone } from '../app/flight';
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
