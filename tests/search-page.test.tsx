// Search on the page, as far as it can be checked without a browser: marking the matches, the
// line a result shows, waiting after the last key, answers that arrive out of order, and the
// markup of the list. Typing, the keyboard, the narrow layout and going to a message need a real
// browser and are checked by hand (see the pull request).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SEARCH_WAIT_MS, SearchResults, queryProblem, searchNote } from '../app/search';
import type { Message } from '../lib/core';
import type { Participant } from '../lib/shared';
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
  // The writer's own line comes before a quoted one; a quoted line is shown only when the word is nowhere else.
  const quoting = { text: '> **Claude** in #2:\n>\n> DECISION: kiwi one\n\nkiwi four only quotes a decision' };
  assert.equal(matchLine(quoting, ['kiwi']), 'kiwi four only quotes a decision');
  assert.equal(matchLine(quoting, ['one']), '> DECISION: kiwi one');
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

/** The participants as GET /api/participants gives them when the PARTICIPANTS setting is not set. */
const PARTICIPANTS: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0 },
  { name: 'claude', kind: 'agent', color: 1 },
  { name: 'david', kind: 'human', color: 2 },
];
const message = (over: Partial<Message>): Message => ({
  id: 1, sender: 'grok', recipient: null, text: '', created_at: '2026-11-20T09:30:00.000Z', pinned_at: null, room: 'main', attachments: [], reply_to: null, poll: null, reactions: [], ...over,
});

test('a result shows sender, time, number and one line with the matches marked', () => {
  const results = [
    message({ id: 46, sender: 'claude', text: 'DECISION: Images go into the database.', pinned_at: '2026-11-20T09:31:00.000Z' }),
    message({ id: 45, sender: 'grok', text: 'Intro.\nWhich storage for the images?' }),
  ];
  const out = renderToStaticMarkup(
    <SearchResults listId="s" results={results} words={['images']} active={1} onPick={() => {}} participants={PARTICIPANTS} />,
  );
  assert.match(out, /^<ul id="s" role="listbox" aria-label="Search results"/);
  const options = [...out.matchAll(/<li id="(s-\d+)" role="option" aria-selected="(true|false)"[^>]*>(.*?)<\/li>/g)];
  assert.deepEqual(options.map((o) => [o[1], o[2]]), [['s-46', 'false'], ['s-45', 'true']]);
  const [first, second] = options.map((o) => o[3]);
  assert.match(first, /<span class="font-bold" style="color:#c792ea">Claude<\/span><time dateTime="2026-11-20T09:30:00\.000Z">20\.11\.26, \d\d:30<\/time><span>#46<\/span><span [^>]*>.*Decision<\/span><span>pinned<\/span>/);
  // The badge is the one from the stream: the word in a label, never an emoji.
  assert.ok(!/✅|✔|✓|📌/.test(out), out);
  assert.match(first, /DECISION: <\/span><mark[^>]*>Images<\/mark><span> go into the database\.<\/span>/);
  assert.match(second, /<span class="font-bold" style="color:#f0883e">Grok<\/span>.*<span>#45<\/span><\/div>/);
  assert.ok(!second.includes('pinned') && !second.includes('Decision'), 'neither pinned nor a decision');
  // The line with the match, not the first line.
  assert.match(second, /<span>Which storage for the <\/span><mark[^>]*>images<\/mark><span>\?<\/span>/);
  assert.ok(!second.includes('Intro'));
});

test('a result shows the Decision badge by the text, and "pinned" by the pin', () => {
  const marks = (m: Message) => {
    const out = renderToStaticMarkup(<SearchResults listId="s" results={[m]} words={['plan']} active={-1} onPick={() => {}} participants={PARTICIPANTS} />);
    const head = /<div class="flex items-baseline[^"]*">(.*?)<\/div>/.exec(out)?.[1] ?? '';
    return { decision: />Decision<\/span>/.test(head), pinned: /<span>pinned<\/span>/.test(head) };
  };
  const at = '2026-11-20T09:31:00.000Z';
  assert.deepEqual(marks(message({ text: 'DECISION: the plan', pinned_at: at })), { decision: true, pinned: true });
  assert.deepEqual(marks(message({ text: 'DECISION: the plan, unpinned later', pinned_at: null })), { decision: true, pinned: false });
  assert.deepEqual(marks(message({ text: 'A plan note, pinned by hand', pinned_at: at })), { decision: false, pinned: true });
  assert.deepEqual(marks(message({ text: '> DECISION: the plan\n\nI only quote it', pinned_at: null })), { decision: false, pinned: false });
});

test('names and colours come from the participants list, whoever they are', () => {
  const others: Participant[] = [{ name: 'ana-maria', kind: 'human', color: 0 }, { name: 'quill-2', kind: 'agent', color: 1 }];
  const results = [
    message({ id: 3, sender: 'quill-2', text: '@ana-maria DECISION: the plan' }),
    message({ id: 2, sender: 'ana-maria', text: '@grok DECISION: not a participant here, so this plan is no decision' }),
    message({ id: 1, sender: 'someone-gone', text: 'a plan from a former participant' }),
  ];
  const out = renderToStaticMarkup(<SearchResults listId="s" results={results} words={['plan']} active={-1} onPick={() => {}} participants={others} />);
  const heads = [...out.matchAll(/<div class="flex items-baseline[^"]*">(.*?)<\/div>/g)].map((m) => m[1]);
  assert.match(heads[0], /<span class="font-bold" style="color:#c792ea">Quill-2<\/span>/);
  assert.match(heads[0], />Decision<\/span>/);
  assert.match(heads[1], /<span class="font-bold" style="color:#f0883e">Ana-Maria<\/span>/);
  assert.ok(!heads[1].includes('Decision'), 'the name before DECISION: is nobody on this hub');
  // Someone who is no longer on the list: the neutral grey, and the name as it is stored.
  assert.match(heads[2], /<span class="font-bold" style="color:#7d8590">Someone-Gone<\/span>/);
});

test('a result is text: nothing from a message becomes markup', () => {
  const nasty = message({ id: 7, text: 'Hello <img src=x onerror=alert(1)> **bold** [link](javascript:alert(1)) <script>x</script> & more' });
  const out = renderToStaticMarkup(
    <SearchResults listId="s" results={[nasty]} words={['bold', '<script>', 'onerror']} active={-1} onPick={() => {}} participants={PARTICIPANTS} />,
  );
  assert.ok(!/<img|<script|<a |<strong|<b>/.test(out), out);
  assert.ok(out.includes('&lt;img src=x '), out);
  assert.ok(out.includes('**</span><mark'), 'Markdown stays as typed');
  assert.match(out, /<mark[^>]*>&lt;script&gt;<\/mark>/);
  assert.ok(out.includes('[link](javascript:alert(1))'), out);
  assert.ok(out.includes('&amp; more'), out);
});
