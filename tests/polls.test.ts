// Tests for polls and votes: input parsing, store (PGlite + memory), and API routes.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX_LENGTH, POLL_QUESTION_MAX_LENGTH,
  parsePollInput, parseVoteInput, type Message, type Poll,
} from '../lib/core';
import { PollError, createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { createEventStream } from '../lib/stream';
import { createSseParser, type SseEvent } from '../lib/sse';

const TOKENS: Record<string, string> = {
  grok: 'grok-polls-token-0123456789abcdef',
  claude: 'claude-polls-token-0123456789abcd',
  david: 'david-polls-token-0123456789abcdef',
};

type Handler = (request: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
let createRoute: { POST: Handler };
let getRoute: { GET: Handler };
let voteRoute: { POST: Handler; DELETE: Handler };
let closeRoute: { POST: Handler };
let messagesRoute: { GET: Handler; POST: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  createRoute = (await import('../app/api/polls/route')) as unknown as typeof createRoute;
  getRoute = (await import('../app/api/polls/[id]/route')) as unknown as typeof getRoute;
  voteRoute = (await import('../app/api/polls/[id]/vote/route')) as unknown as typeof voteRoute;
  closeRoute = (await import('../app/api/polls/[id]/close/route')) as unknown as typeof closeRoute;
  messagesRoute = (await import('../app/api/messages/route')) as unknown as typeof messagesRoute;
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

// The names that apply when PARTICIPANTS is not set.
const THREE = ['grok', 'claude', 'david'];

const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test('parsePollInput trims, enforces lengths, option count, uniqueness and ignores spoofed identity', () => {
  const body = { question: '  Lunch?\n', options: [' Pizza ', 'Salad', 'Soup'], participant: 'david', sender: 'claude', creator: 'david' };
  assert.deepEqual(parsePollInput(body, THREE), { ok: true, question: 'Lunch?', options: ['Pizza', 'Salad', 'Soup'], recipient: null });
  assert.deepEqual(parsePollInput({ question: 'Q', options: ['A', 'B'], to: '@claude' }, THREE), { ok: true, question: 'Q', options: ['A', 'B'], recipient: 'claude' });

  assert.equal(parsePollInput(null, THREE).ok, false);
  assert.equal(parsePollInput([], THREE).ok, false);
  assert.equal(parsePollInput({ question: '   ', options: ['A', 'B'] }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'Q', options: ['A'] }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'Q', options: Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`) }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'Q', options: ['A', 'A'] }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'a'.repeat(POLL_QUESTION_MAX_LENGTH + 1), options: ['A', 'B'] }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'Q', options: ['A', 'b'.repeat(POLL_OPTION_MAX_LENGTH + 1)] }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'ok\u0000', options: ['A', 'B'] }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'Q', options: ['A', 'B'], to: 'mallory' }, THREE).ok, false);
  assert.equal(parsePollInput({ question: 'Q', options: 'A' }, THREE).ok, false);
  assert.ok(parsePollInput({ question: 'a'.repeat(POLL_QUESTION_MAX_LENGTH), options: ['A', 'B'] }, THREE).ok);
  assert.ok(parsePollInput({ question: 'Q', options: Array.from({ length: POLL_MIN_OPTIONS }, (_, i) => `o${i}`) }, THREE).ok);
});

test('parseVoteInput requires a 1-based integer option and ignores participant', () => {
  assert.deepEqual(parseVoteInput({ option: 2, participant: 'david' }), { ok: true, option: 2 });
  assert.equal(parseVoteInput(null).ok, false);
  assert.equal(parseVoteInput({ option: 0 }).ok, false);
  assert.equal(parseVoteInput({ option: 1.5 }).ok, false);
  assert.equal(parseVoteInput({ option: '1' }).ok, false);
  assert.equal(parseVoteInput({ option: POLL_MAX_OPTIONS + 1 }).ok, false);
});

const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];
const must = <T>(v: T | null | undefined): T => { assert.ok(v, 'expected a value'); return v; };

for (const [name, make] of STORES) {
  test(`${name}: create a poll, one vote per person, change, withdraw, close`, async () => {
    const store = await make();
    await store.ensure();
    const created = must(await store.createPoll({ creator: 'david', question: 'Lunch?', options: ['Pizza', 'Salad', 'Soup'] }));
    assert.equal(created.message.sender, 'david');
    assert.equal(created.message.text, 'Lunch?');
    assert.equal(created.message.poll?.id, created.poll.id);
    assert.match(created.poll.id, /^poll_[a-z0-9]{8,48}$/);
    assert.deepEqual(created.poll.options.map((o) => o.text), ['Pizza', 'Salad', 'Soup']);
    assert.equal(created.poll.options[0].index, 1);
    assert.equal(created.poll.closed_at, null);

    const afterGrok = await store.vote(created.poll.id, 'grok', 1);
    assert.deepEqual(afterGrok.options[0].voters, ['grok']);
    assert.equal(afterGrok.options[0].votes, 1);

    const changed = await store.vote(created.poll.id, 'grok', 2);
    assert.deepEqual(changed.options[0].voters, []);
    assert.deepEqual(changed.options[1].voters, ['grok']);
    assert.equal(changed.options.reduce((n, o) => n + o.votes, 0), 1, 'still one vote after a change');

    await store.vote(created.poll.id, 'claude', 2);
    const listed = (await store.list({ since: 0 })).find((m) => m.id === created.message.id);
    assert.deepEqual([...(listed?.poll?.options[1].voters ?? [])].sort(), ['claude', 'grok']);

    const withdrawn = await store.unvote(created.poll.id, 'grok');
    assert.equal(withdrawn.withdrawn, true);
    assert.deepEqual(withdrawn.poll.options[1].voters, ['claude']);
    assert.equal((await store.unvote(created.poll.id, 'grok')).withdrawn, false);

    const closed = await store.closePoll(created.poll.id, 'david');
    assert.ok(closed.closed_at);
    const again = await store.closePoll(created.poll.id, 'david');
    assert.equal(again.closed_at, closed.closed_at);

    await assert.rejects(store.vote(created.poll.id, 'claude', 1), (e: unknown) => e instanceof PollError && e.reason === 'closed');
    await assert.rejects(store.unvote(created.poll.id, 'claude'), (e: unknown) => e instanceof PollError && e.reason === 'closed');
    await assert.rejects(store.closePoll(created.poll.id, 'grok'), (e: unknown) => e instanceof PollError && e.reason === 'not the creator');
    await assert.rejects(store.vote('poll_deadbeefdeadbeefdeadbeef', 'david', 1), (e: unknown) => e instanceof PollError && e.reason === 'not found');

    const open = must(await store.createPoll({ creator: 'grok', question: 'Colour?', options: ['Red', 'Blue'] }));
    await assert.rejects(store.vote(open.poll.id, 'david', 3), (e: unknown) => e instanceof PollError && e.reason === 'bad option');

    const before = (await store.version()).polls;
    await store.vote(open.poll.id, 'david', 1);
    assert.notEqual((await store.version()).polls, before);
  });

  test(`${name}: creating a poll uses the message rate limit`, async () => {
    const store = await make();
    await store.ensure();
    for (let i = 0; i < 3; i++) assert.ok(await store.createPoll({ creator: 'claude', question: `Q${i}?`, options: ['A', 'B'] }, 3));
    assert.equal(await store.createPoll({ creator: 'claude', question: 'Q4?', options: ['A', 'B'] }, 3), null);
    assert.ok(await store.createPoll({ creator: 'david', question: 'Other?', options: ['A', 'B'] }, 3));
  });
}

test('SQL: the checks that listed three names are replaced by checks on the shape of a name', async () => {
  // Who is a participant is the application's business (PARTICIPANTS). The tables refuse what could never be a name.
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();
  const names = (await pg.query(`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('polls'::regclass, 'poll_votes'::regclass) AND conname ~ 'participant|creator' ORDER BY 1`)).rows as { conname: string }[];
  assert.deepEqual(names.map((r) => r.conname), ['poll_votes_participant_shape', 'polls_creator_shape']);
  await assert.rejects(store.createPoll({ creator: 'Not A Name', question: 'Q?', options: ['A', 'B'] }), /messages_sender_shape|polls_creator_shape/);
  const created = await store.createPoll({ creator: 'quill-2', question: 'A fourth participant asks?', options: ['A', 'B'] });
  assert.ok(created);
  await assert.rejects(store.vote(created.poll.id, 'NOPE', 1), /poll_votes_participant_shape/);
  assert.deepEqual((await store.vote(created.poll.id, 'ana-maria', 2)).options[1].voters, ['ana-maria']);
});

const BASE = 'http://hub.test';

test('API /api/polls: 401 without a valid token', async () => {
  for (const who of [undefined, 'wrong-token-0123456789abcdef']) {
    assert.equal((await createRoute.POST(new Request(`${BASE}/api/polls`, { method: 'POST', headers: auth(who), body: JSON.stringify({ question: 'Q?', options: ['A', 'B'] }) }))).status, 401);
    assert.equal((await getRoute.GET(new Request(`${BASE}/api/polls/poll_aaaaaaaaaaaaaaaaaaaaaaaa`, { headers: auth(who) }), params('poll_aaaaaaaaaaaaaaaaaaaaaaaa'))).status, 401);
    assert.equal((await voteRoute.POST(new Request(`${BASE}/api/polls/poll_aaaaaaaaaaaaaaaaaaaaaaaa/vote`, { method: 'POST', headers: auth(who), body: JSON.stringify({ option: 1 }) }), params('poll_aaaaaaaaaaaaaaaaaaaaaaaa'))).status, 401);
    assert.equal((await voteRoute.DELETE(new Request(`${BASE}/api/polls/poll_aaaaaaaaaaaaaaaaaaaaaaaa/vote`, { method: 'DELETE', headers: auth(who) }), params('poll_aaaaaaaaaaaaaaaaaaaaaaaa'))).status, 401);
    assert.equal((await closeRoute.POST(new Request(`${BASE}/api/polls/poll_aaaaaaaaaaaaaaaaaaaaaaaa/close`, { method: 'POST', headers: auth(who) }), params('poll_aaaaaaaaaaaaaaaaaaaaaaaa'))).status, 401);
  }
});

test('API /api/polls: create, list on messages, spoofing ignored, vote/change/withdraw, close', async () => {
  const created = await createRoute.POST(new Request(`${BASE}/api/polls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('david') },
    body: JSON.stringify({ question: '  Ship it?  ', options: [' Yes ', 'No', 'Later'], participant: 'grok', sender: 'claude', creator: 'grok' }),
  }));
  assert.equal(created.status, 201);
  const body = (await created.json()) as { message: Message; poll: Poll };
  assert.equal(body.message.sender, 'david');
  assert.equal(body.poll.creator, 'david');
  assert.equal(body.poll.question, 'Ship it?');
  assert.deepEqual(body.poll.options.map((o) => o.text), ['Yes', 'No', 'Later']);
  const pollId = body.poll.id;

  const listed = await messagesRoute.GET(new Request(`${BASE}/api/messages?since=0`, { headers: auth('grok') }));
  assert.equal(listed.status, 200);
  const listBody = (await listed.json()) as { messages: Message[]; polls: Poll[] };
  const onMessage = listBody.messages.find((m) => m.id === body.message.id);
  assert.equal(onMessage?.poll?.id, pollId);
  assert.ok(listBody.polls.some((p) => p.id === pollId));

  const spoofVote = await voteRoute.POST(new Request(`${BASE}/api/polls/${pollId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('grok') },
    body: JSON.stringify({ option: 1, participant: 'david' }),
  }), params(pollId));
  assert.equal(spoofVote.status, 200);
  const afterGrok = (await spoofVote.json()) as { poll: Poll };
  assert.deepEqual(afterGrok.poll.options[0].voters, ['grok']);

  const change = await voteRoute.POST(new Request(`${BASE}/api/polls/${pollId}/vote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('grok') }, body: JSON.stringify({ option: 2 }),
  }), params(pollId));
  assert.equal(change.status, 200);
  const changed = (await change.json()) as { poll: Poll };
  assert.deepEqual(changed.poll.options[0].voters, []);
  assert.deepEqual(changed.poll.options[1].voters, ['grok']);

  const got = await getRoute.GET(new Request(`${BASE}/api/polls/${pollId}`, { headers: auth('claude') }), params(pollId));
  assert.equal(got.status, 200);
  assert.deepEqual(((await got.json()) as { poll: Poll }).poll.options[1].voters, ['grok']);

  const withdrawn = await voteRoute.DELETE(new Request(`${BASE}/api/polls/${pollId}/vote`, { method: 'DELETE', headers: auth('grok') }), params(pollId));
  assert.equal(withdrawn.status, 200);
  const withdrawnBody = (await withdrawn.json()) as { poll: Poll; withdrawn: boolean };
  assert.equal(withdrawnBody.withdrawn, true);
  assert.deepEqual(withdrawnBody.poll.options[1].voters, []);
  assert.equal(withdrawnBody.poll.options[1].votes, 0);

  const closed = await closeRoute.POST(new Request(`${BASE}/api/polls/${pollId}/close`, { method: 'POST', headers: auth('david') }), params(pollId));
  assert.equal(closed.status, 200);
  assert.ok(((await closed.json()) as { poll: Poll }).poll.closed_at);

  assert.equal((await voteRoute.POST(new Request(`${BASE}/api/polls/${pollId}/vote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('claude') }, body: JSON.stringify({ option: 1 }),
  }), params(pollId))).status, 409);
  assert.equal((await closeRoute.POST(new Request(`${BASE}/api/polls/${pollId}/close`, { method: 'POST', headers: auth('claude') }), params(pollId))).status, 403);

  assert.equal((await createRoute.POST(new Request(`${BASE}/api/polls`, {
    method: 'POST', headers: auth('david'), body: JSON.stringify({ question: '', options: ['A', 'B'] }),
  }))).status, 400);
  assert.equal((await getRoute.GET(new Request(`${BASE}/api/polls/not-an-id`, { headers: auth('david') }), params('not-an-id'))).status, 400);
  assert.equal((await getRoute.GET(new Request(`${BASE}/api/polls/poll_ffffffffffffffffffffffff`, { headers: auth('david') }), params('poll_ffffffffffffffffffffffff'))).status, 404);
});

test('the live stream pushes an updated poll message when someone votes', async () => {
  const store = createMemoryStore();
  const created = must(await store.createPoll({ creator: 'david', question: 'Ready?', options: ['Yes', 'No'] }));
  const events: SseEvent[] = [];
  const abort = new AbortController();
  const stream = createEventStream({ store, me: 'claude', since: null, signal: abort.signal, intervalMs: 20, heartbeatMs: 10_000, maxMs: 5_000 });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser((e) => events.push(e));
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  })();
  const waitFor = async (event: string, after = 0) => {
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const hit = events.slice(after).find((e) => e.event === event);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`no ${event} event`);
  };
  await waitFor('hello');
  await store.vote(created.poll.id, 'grok', 2);
  const update = await waitFor('messages', 2);
  const messages = JSON.parse(update.data) as Message[];
  const pollMessage = messages.find((m) => m.poll?.id === created.poll.id);
  assert.deepEqual(pollMessage?.poll?.options[1].voters, ['grok']);
  abort.abort();
  await pump.catch(() => {});
});
