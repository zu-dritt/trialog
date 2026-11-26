// The "New version available" pill: when the page knows of another build, what the pill looks
// like, and how the page learns which build the server runs. Reloading itself needs a browser and
// two builds, and is checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { NEW_VERSION_HINT, NewVersionPill } from '../app/version';
import { BUILD_ID, isOtherBuild } from '../lib/build';
import { createSseParser, type SseEvent } from '../lib/sse';
import { createMemoryStore } from '../lib/store';
import { createEventStream } from '../lib/stream';

test('another build is one whose id differs; a missing id never counts', () => {
  assert.equal(isOtherBuild('a1b2c3', 'd4e5f6'), true);
  assert.equal(isOtherBuild('a1b2c3', 'a1b2c3'), false);
  // An older server that reports no build, or a page without one: nothing to say.
  for (const [page, server] of [['a1b2c3', undefined], ['a1b2c3', null], ['a1b2c3', ''], ['', 'd4e5f6'], [undefined, 'd4e5f6'], ['a1b2c3', 7], ['a1b2c3', { id: 'x' }]]) {
    assert.equal(isOtherBuild(page, server), false, JSON.stringify([page, server]));
  }
  assert.equal(BUILD_ID, 'dev', 'where no build set an id, as in these tests');
});

test('the pill is one button that says "New version available" and what a click does', () => {
  const out = renderToStaticMarkup(<NewVersionPill onReload={() => {}} />);
  // One real button and nothing else: reachable with Tab, pressed with Enter or Space.
  assert.match(out, /^<button type="button"[^>]*>.*<\/button>$/);
  assert.equal(out.match(/<button/g)?.length, 1);
  // The words are there as text.
  assert.equal(out.replace(/<[^>]+>/g, ''), 'New version available');
  // The tooltip says what the click does, and the name a screen reader reads starts with the visible words.
  assert.equal(NEW_VERSION_HINT, 'Reload to get the newest version. Your unsent message is kept.');
  assert.ok(out.includes(`title="${NEW_VERSION_HINT}"`), out);
  assert.ok(out.includes(`aria-label="New version available. ${NEW_VERSION_HINT}"`), out);
  // The dot in front is decoration.
  assert.match(out, /<span aria-hidden="true"[^>]*><\/span>/);
  // Quiet: shaped as a pill, and nothing in it moves.
  assert.match(out, /class="[^"]*\brounded-full\b/);
  assert.ok(!/animate|transition|blink|pulse/.test(out), out);
  // No link, no script, no timer in the markup, and nothing about where the page is hosted.
  assert.ok(!/<a |<script|http|refresh/i.test(out), out);
});

test('the pill takes a class from the page, which places it', () => {
  assert.match(renderToStaticMarkup(<NewVersionPill onReload={() => {}} className="max-md:hidden" />), /class="[^"]* max-md:hidden"/);
});

test('a click on the pill asks for the reload; rendering it does not', () => {
  let reloads = 0;
  const pill = NewVersionPill({ onReload: () => { reloads += 1; } });
  assert.equal(reloads, 0, 'the page never reloads by itself');
  pill.props.onClick();
  assert.equal(reloads, 1);
});

/** Reads a stream to its end and returns its events. */
async function events(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  const parser = createSseParser((e) => out.push(e));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  return out;
}

test('the stream says which build the server runs in its first event, and only there', async () => {
  const store = createMemoryStore();
  const withBuild = await events(createEventStream({ store, me: 'david', since: null, build: '3f9c2a7be4d1', intervalMs: 5, maxMs: 20 }));
  assert.equal(withBuild[0].event, 'hello');
  assert.deepEqual(JSON.parse(withBuild[0].data), { me: 'david', build: '3f9c2a7be4d1' });
  assert.ok(withBuild.slice(1).every((e) => !e.data.includes('3f9c2a7be4d1')), 'no other event carries it');
  // Without a build id the event is exactly what it was before, so an older reader of the stream sees no difference.
  const without = await events(createEventStream({ store, me: 'david', since: null, intervalMs: 5, maxMs: 20 }));
  assert.deepEqual(JSON.parse(without[0].data), { me: 'david' });
});
