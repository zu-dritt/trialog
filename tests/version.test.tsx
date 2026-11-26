// The "a newer version is available" note: when it shows, what it looks like, and how the page
// learns which build the server runs. Reloading itself needs a browser and two builds, and is
// checked by hand (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewVersionNotice, showNewVersion } from '../app/version';
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

test('the note shows for another build until it is put away, and again for the next one', () => {
  const show = (server: string | null, dismissed: string | null) => showNewVersion('build-1', server, dismissed, isOtherBuild);
  assert.equal(show(null, null), false, 'before the server has said anything');
  assert.equal(show('build-1', null), false, 'the same build');
  assert.equal(show('build-2', null), true, 'a newer one was deployed');
  assert.equal(show('build-2', 'build-2'), false, 'put away by the reader');
  assert.equal(show('build-3', 'build-2'), true, 'yet another build: it comes back');
  assert.equal(show('build-1', 'build-2'), false, 'back on the page\'s own build: nothing to say');
});

test('the note says what happened and offers Reload and a way to put it away, nothing more', () => {
  const out = renderToStaticMarkup(<NewVersionNotice onReload={() => {}} onDismiss={() => {}} />);
  assert.match(out, /^<div role="status" aria-live="polite"/, 'announced quietly, not as an alert');
  assert.match(out, /A newer version of Trialog is available\./);
  const buttons = [...out.matchAll(/<button type="button"([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], /aria-label="([^"]*)"/.exec(m[1])?.[1] ?? null]);
  assert.deepEqual(buttons, [['Reload', null], ['×', 'Dismiss this note']]);
  assert.match(out, /title="Load the newer version\. The text of an unsent message is kept\."/);
  // It is a note with two buttons: no link, no script, no timer in the markup, and nothing about where the page is hosted.
  assert.ok(!/<a |<script|http|refresh/i.test(out), out);
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
