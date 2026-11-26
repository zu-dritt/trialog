// Search on the page, as far as it can be checked without a browser: marking the matches, the
// line a result shows, waiting after the last key, answers that arrive out of order, and the
// markup of the list. Typing, the keyboard, the narrow layout and going to a message need a real
// browser and are checked by hand (see the pull request).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SEARCH_WAIT_MS, SearchResults, queryProblem, searchNote } from '../app/search';
import type { Author, Message } from '../lib/core';
import { SEARCH_LIMIT, debounce, markMatches, matchLine, matchesAll, newestOnly, parseQuery, searchLines } from '../lib/search';

const hits = (line: string, words: string[]) => markMatches(line, words).map((p) => (p.hit ? `[${p.text}]` : p.text)).join('');

test('the matching words are marked, as they are written in the message', () => {
  assert.equal(hits('Images go into the database.', ['images']), '[Images] go into the database.');
  assert.equal(hits('Images go into the database.', ['DATA', 'go']), 'Images [go] into the [data]base.');
  assert.equal(hits('storage, Storage, STORAGE', ['storage']), '[storage], [Storage], [STORAGE]');
  // The pieces put together are the line, whatever is marked.
  for (const words of [['a'], ['the', 'e'], ['zebra'], ['.'], ['']]) {
    assert.equal(markMatches('Images go into the database.', words).map((p) => p.text).join(''), 'Images go into the database.');
  }
  // Where two words start at the same place, the longer one is marked.
  assert.equal(hits('a decision', ['dec', 'decision']), 'a [decision]');
  // Characters that mean something to a regular expression are plain text.
  assert.equal(hits('We are at 100% (really?) [yes].*', ['100%', '(really?)', '[yes].*']), 'We are at [100%] [(really?)] [[yes].*]');
  assert.equal(hits('a.b axb', ['a.b']), '[a.b] axb');
  assert.equal(hits('C:\\temp', ['c:\\t']), '[C:\\t]emp');
  // Nothing to mark.
  assert.deepEqual(markMatches('plain', []), [{ text: 'plain', hit: false }]);
  assert.deepEqual(markMatches('plain', ['zebra']), [{ text: 'plain', hit: false }]);
  assert.deepEqual(markMatches('', ['a']), []);
  // Letters beyond a to z.
  assert.equal(hits('Grüsse aus ZÜRICH', ['zürich']), 'Grüsse aus [ZÜRICH]');
});

test('a result shows the line with the most matching words', () => {
  const m = { text: 'First line about storage.\n\nThe images go into the storage we chose.\nLast line.' };
  assert.equal(matchLine(m, ['storage']), 'First line about storage.');
  assert.equal(matchLine(m, ['storage', 'images']), 'The images go into the storage we chose.');
  assert.equal(matchLine(m, ['last']), 'Last line.');
  // Words on different lines: the lines that have them, so every word can be seen.
  assert.equal(matchLine(m, ['first', 'last']), 'First line about storage. · Last line.');
  assert.equal(matchLine(m, ['zebra']), 'First line about storage.', 'nothing to show: the first line');
  // A poll: an option can be the line.
  const poll = { text: 'Where do we eat?', poll: { question: 'Where do we eat?', options: [{ text: 'Pizza place' }, { text: 'Salad bar' }] } };
  assert.deepEqual(searchLines(poll), ['Where do we eat?', 'Pizza place', 'Salad bar']);
  assert.equal(matchLine(poll, ['salad']), 'Salad bar');
  assert.equal(matchLine(poll, ['eat']), 'Where do we eat?');
  assert.equal(matchLine(poll, ['eat', 'salad']), 'Where do we eat? · Salad bar');
  // In the order of the message, whatever the order of the words.
  assert.equal(matchLine(poll, ['bar', 'pizza', 'where']), 'Where do we eat? · Pizza place · Salad bar');
  assert.equal(matchesAll(poll, ['EAT', 'pizza', 'bar']), true);
  assert.equal(matchesAll(poll, ['eat', 'soup']), false);
});

test('a long line is cut around its first match', () => {
  const long = `${'start '.repeat(40)}the needle is here ${'end '.repeat(40)}`;
  const line = matchLine({ text: long }, ['needle'], 80);
  assert.ok(line.length <= 80, String(line.length));
  assert.ok(line.includes('needle'), line);
  assert.ok(line.startsWith('…') && line.endsWith('…'), line);
  // A match near the start: the line starts where the message starts.
  const early = matchLine({ text: `needle first, then ${'more '.repeat(60)}` }, ['needle'], 80);
  assert.ok(early.startsWith('needle first') && early.endsWith('…') && early.length <= 80, early);
  // A short line is not cut.
  assert.equal(matchLine({ text: 'short needle' }, ['needle'], 80), 'short needle');
});

test('the page waits 250 ms after the last key, and asks once', () => {
  assert.equal(SEARCH_WAIT_MS, 250);
  vi.useFakeTimers();
  try {
    const asked: string[] = [];
    const ask = debounce((q: string) => { asked.push(q); }, SEARCH_WAIT_MS);
    ask.call('s');
    vi.advanceTimersByTime(100);
    ask.call('st');
    vi.advanceTimersByTime(249);
    ask.call('sto');
    vi.advanceTimersByTime(249);
    assert.deepEqual(asked, [], 'still typing');
    vi.advanceTimersByTime(1);
    assert.deepEqual(asked, ['sto'], 'once, with what was typed last');
    vi.advanceTimersByTime(1000);
    assert.deepEqual(asked, ['sto']);
    // A call that is still waiting can be dropped, for example when the field is emptied.
    ask.call('stor');
    ask.cancel();
    vi.advanceTimersByTime(1000);
    assert.deepEqual(asked, ['sto']);
    ask.call('storage');
    vi.advanceTimersByTime(250);
    assert.deepEqual(asked, ['sto', 'storage']);
  } finally {
    vi.useRealTimers();
  }
});

test('an answer that arrives after a newer question was asked is dropped', async () => {
  const order = newestOnly();
  const shown: string[] = [];
  const ask = (q: string, ms: number) => {
    const ticket = order.ticket();
    return new Promise<void>((resolve) => setTimeout(() => {
      if (order.isNewest(ticket)) shown.push(q);
      resolve();
    }, ms));
  };
  // The answer to the first question is slow and arrives last.
  await Promise.all([ask('sto', 30), ask('stor', 1), ask('storage', 10)]);
  assert.deepEqual(shown, ['storage']);
  // Emptying the field takes a ticket too, so an answer still on its way is dropped.
  const late = ask('images', 5);
  order.ticket();
  await late;
  assert.deepEqual(shown, ['storage']);
});

test('what the panel says', () => {
  const words = ['x'];
  const result = (id: number) => ({ id }) as Message;
  assert.match(searchNote({ kind: 'idle' }, false), /Type a word or two/);
  assert.equal(searchNote({ kind: 'searching' }, false), 'Searching…');
  assert.equal(searchNote({ kind: 'done', results: [], words }, false), 'Nothing found.');
  assert.equal(searchNote({ kind: 'done', results: [], words }, true), 'No decision found.');
  assert.equal(searchNote({ kind: 'done', results: [result(1)], words }, false), '');
  assert.match(searchNote({ kind: 'done', results: Array.from({ length: SEARCH_LIMIT }, (_, i) => result(i)), words }, false), /newest 50/);
  // What is not a query is said in the server's words, addressed to a person.
  const tooMany = parseQuery('a b c d e f g h i');
  assert.ok(!tooMany.ok);
  assert.equal(queryProblem(tooMany.error), 'A search can have at most 8 words.');
  assert.equal(searchNote({ kind: 'problem', message: queryProblem(tooMany.error) }, false), 'A search can have at most 8 words.');
});

const NAMES: Record<Author, string> = { grok: 'Grok', claude: 'Claude', david: 'David', hub: 'Hub' };
const message = (over: Partial<Message>): Message => ({
  id: 1, sender: 'grok', recipient: null, text: '', created_at: '2026-11-20T09:30:00.000Z', pinned_at: null, attachments: [], reply_to: null, poll: null, ...over,
});

test('a result shows sender, time, number and one line with the matches marked', () => {
  const results = [
    message({ id: 46, sender: 'claude', text: 'DECISION: Images go into the database.', pinned_at: '2026-11-20T09:31:00.000Z' }),
    message({ id: 45, sender: 'grok', text: 'Intro.\nWhich storage for the images?' }),
  ];
  const out = renderToStaticMarkup(
    <SearchResults listId="s" results={results} words={['images']} active={1} onPick={() => {}} names={NAMES} colour={(s) => `text-${s}`} />,
  );
  assert.match(out, /^<ul id="s" role="listbox" aria-label="Search results"/);
  const options = [...out.matchAll(/<li id="(s-\d+)" role="option" aria-selected="(true|false)"[^>]*>(.*?)<\/li>/g)];
  assert.deepEqual(options.map((o) => [o[1], o[2]]), [['s-46', 'false'], ['s-45', 'true']]);
  const [first, second] = options.map((o) => o[3]);
  assert.match(first, /<span class="font-bold text-claude">Claude<\/span><time dateTime="2026-11-20T09:30:00\.000Z">20\.11\.26, \d\d:30<\/time><span>#46<\/span><span>pinned<\/span>/);
  assert.match(first, /DECISION: <\/span><mark[^>]*>Images<\/mark><span> go into the database\.<\/span>/);
  assert.match(second, /<span class="font-bold text-grok">Grok<\/span>.*<span>#45<\/span><\/div>/);
  assert.ok(!second.includes('pinned'));
  // The line with the match, not the first line.
  assert.match(second, /<span>Which storage for the <\/span><mark[^>]*>images<\/mark><span>\?<\/span>/);
  assert.ok(!second.includes('Intro'));
});

test('a result is text: nothing from a message becomes markup', () => {
  const nasty = message({ id: 7, text: 'Hello <img src=x onerror=alert(1)> **bold** [link](javascript:alert(1)) <script>x</script> & more' });
  const out = renderToStaticMarkup(
    <SearchResults listId="s" results={[nasty]} words={['bold', '<script>', 'onerror']} active={-1} onPick={() => {}} names={NAMES} colour={() => ''} />,
  );
  assert.ok(!/<img|<script|<a |<strong|<b>/.test(out), out);
  assert.ok(out.includes('&lt;img src=x '), out);
  assert.ok(out.includes('**</span><mark'), 'Markdown stays as typed');
  assert.match(out, /<mark[^>]*>&lt;script&gt;<\/mark>/);
  assert.ok(out.includes('[link](javascript:alert(1))'), out);
  assert.ok(out.includes('&amp; more'), out);
});
