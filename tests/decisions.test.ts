// Tests for decision cards: input parsing, store (PGlite + memory), and API routes.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  parseDecisionInput, parseDecisionPosition, type Message,
} from '../lib/core';
import { decisionIsAgreed, decisionPositionText } from '../lib/shared';
import { DecisionError, createMemoryStore, createSqlStore, type Db, type Row, type Store } from '../lib/store';
import { createEventStream } from '../lib/stream';
import { createSseParser, type SseEvent } from '../lib/sse';

const TOKENS: Record<string, string> = {
  grok: 'grok-decisions-token-0123456789abcd',
  claude: 'claude-decisions-token-0123456789ab',
  david: 'david-decisions-token-0123456789abc',
};

type Handler = (request: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
let createRoute: { POST: Handler };
let positionRoute: { PUT: Handler };
let messagesRoute: { GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  createRoute = (await import('../app/api/decisions/route')) as unknown as typeof createRoute;
  positionRoute = (await import('../app/api/decisions/[id]/route')) as unknown as typeof positionRoute;
  messagesRoute = (await import('../app/api/messages/route')) as unknown as typeof messagesRoute;
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

const THREE = ['grok', 'claude', 'david'];
const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const must = <T>(v: T | null | undefined): T => { assert.ok(v); return v; };

test('parseDecisionInput trims the prompt, accepts to and reply_to, and ignores spoofed identity', () => {
  const body = { prompt: '  Ship it?  ', participant: 'david', sender: 'claude', creator: 'david' };
  assert.deepEqual(parseDecisionInput(body, THREE), { ok: true, prompt: 'Ship it?', recipient: null, replyTo: null });
  assert.deepEqual(parseDecisionInput({ prompt: 'Q', to: '@claude', reply_to: 4 }, THREE), { ok: true, prompt: 'Q', recipient: 'claude', replyTo: 4 });
  assert.equal(parseDecisionInput(null, THREE).ok, false);
  assert.equal(parseDecisionInput({ prompt: '   ' }, THREE).ok, false);
  assert.equal(parseDecisionInput({ prompt: 'Q', to: 'mallory' }, THREE).ok, false);
  assert.equal(parseDecisionInput({ prompt: 'Q', reply_to: 0 }, THREE).ok, false);
});

test('parseDecisionPosition requires a stance; a note is optional for Agree and required for Object', () => {
  assert.deepEqual(parseDecisionPosition({ stance: 'agree', participant: 'david' }), { ok: true, stance: 'agree', note: null });
  assert.deepEqual(parseDecisionPosition({ stance: 'agree', note: '  Yes, build it.  ' }), { ok: true, stance: 'agree', note: 'Yes, build it.' });
  assert.deepEqual(parseDecisionPosition({ stance: 'object', note: 'The migration is not numbered.' }), { ok: true, stance: 'object', note: 'The migration is not numbered.' });
  assert.equal(parseDecisionPosition({ stance: 'object' }).ok, false);
  assert.equal(parseDecisionPosition({ stance: 'object', note: '   ' }).ok, false);
  assert.equal(parseDecisionPosition({ stance: 'maybe' }).ok, false);
  assert.equal(parseDecisionPosition(null).ok, false);
});

test('decisionIsAgreed is true only when every current participant has agreed', () => {
  const card = {
    positions: [
      { participant: 'david', stance: 'agree' as const, note: 'Yes, build it.', updated_at: 't' },
      { participant: 'claude', stance: 'agree' as const, note: null, updated_at: 't' },
    ],
  };
  assert.equal(decisionIsAgreed(card, ['david', 'claude']), true);
  assert.equal(decisionIsAgreed(card, ['david', 'claude', 'grok']), false);
  assert.equal(decisionIsAgreed({ positions: [...card.positions, { participant: 'grok', stance: 'object', note: 'No', updated_at: 't' }] }, ['david', 'claude', 'grok']), false);
});

function stores(): [string, () => Promise<Store>][] {
  return [
    ['memory', async () => createMemoryStore()],
    ['sql', async () => {
      const pg = new PGlite();
      return createSqlStore(pgliteDb(pg));
    }],
  ];
}

test('decisionPositionText names the stance, the note, and when everyone has agreed or not', () => {
  assert.equal(decisionPositionText('agree', null), 'Agree.');
  assert.equal(decisionPositionText('agree', 'Yes, build it.'), 'Agree: Yes, build it.');
  assert.equal(decisionPositionText('object', 'The migration is not numbered.'), 'Object: The migration is not numbered.');
  assert.equal(decisionPositionText('agree', 'Yes, build it.', 'agreed'), 'Agree: Yes, build it.\n\nEveryone has agreed.');
  assert.equal(decisionPositionText('object', 'Need a number first.', 'broken'), 'Object: Need a number first.\n\nThis is no longer agreed.');
});

for (const [name, make] of stores()) {
  test(`${name}: the proposer counts as agreed; everyone agreeing pins the message; an object unpins it`, async () => {
    const store = await make();
    const created = must(await store.createDecision({ creator: 'david', prompt: 'Ship the decision card?' }, THREE));
    assert.equal(created.decision.prompt, 'Ship the decision card?');
    assert.equal(created.message.pinned_at, null);
    assert.equal(created.decision.agreed_at, null);
    assert.deepEqual(created.decision.positions.map((p) => [p.participant, p.stance]), [['david', 'agree']]);

    const claude = await store.recordDecisionPosition(created.decision.id, 'claude', 'agree', 'Yes, build it.', THREE);
    assert.equal(claude.status, 'ok');
    if (claude.status === 'ok') {
      assert.ok(claude.reply);
      assert.equal(claude.reply.sender, 'claude');
      assert.equal(claude.reply.reply_to, created.message.id);
      assert.equal(claude.reply.text, 'Agree: Yes, build it.');
      assert.equal(claude.decision.agreed_at, null);
    }

    const same = await store.recordDecisionPosition(created.decision.id, 'claude', 'agree', 'Yes, build it.', THREE);
    assert.equal(same.status, 'ok');
    if (same.status === 'ok') assert.equal(same.reply, null, 'a repeated identical position posts nothing');

    const last = await store.recordDecisionPosition(created.decision.id, 'grok', 'agree', null, THREE);
    assert.equal(last.status, 'ok');
    if (last.status === 'ok') {
      assert.ok(last.decision.agreed_at);
      assert.ok(last.message.pinned_at);
      assert.equal(decisionIsAgreed(last.decision, THREE), true);
      assert.equal(last.reply?.text, 'Agree.\n\nEveryone has agreed.');
    }

    const objected = await store.recordDecisionPosition(created.decision.id, 'claude', 'object', 'Need a migration number first.', THREE);
    assert.equal(objected.status, 'ok');
    if (objected.status === 'ok') {
      assert.equal(objected.decision.agreed_at, null);
      assert.equal(objected.message.pinned_at, null, 'an auto-pin is taken back when consensus breaks');
      assert.equal(objected.reply?.text, 'Object: Need a migration number first.\n\nThis is no longer agreed.');
    }
  });

  test(`${name}: an Agree is rate-limited like a post, and the position is not recorded`, async () => {
    const store = await make();
    const created = must(await store.createDecision({ creator: 'david', prompt: 'Q' }, THREE));
    for (let i = 0; i < 30; i++) {
      assert.ok(await store.add({ sender: 'claude', recipient: null, text: `fill ${i}` }));
    }
    const result = await store.recordDecisionPosition(created.decision.id, 'claude', 'agree', null, THREE, 30);
    assert.equal(result.status, 'rate_limited');
    assert.equal((await store.listDecisions())[0].positions.some((p) => p.participant === 'claude'), false);
  });

  test(`${name}: the database or memory store refuses an Object without a note`, async () => {
    const store = await make();
    const created = must(await store.createDecision({ creator: 'david', prompt: 'Q' }));
    await assert.rejects(
      store.recordDecisionPosition(created.decision.id, 'claude', 'object', null, THREE),
      DecisionError,
    );
  });

  test(`${name}: a position on an older card is re-sent without moving last`, async () => {
    const store = await make();
    const created = must(await store.createDecision({ creator: 'david', prompt: 'old card' }));
    const later = must(await store.add({ sender: 'grok', recipient: null, text: 'new' }));
    const abort = new AbortController();
    const events: { event: string; data: unknown }[] = [];
    const stream = createEventStream({ store, me: 'claude', since: later.id, signal: abort.signal, intervalMs: 20, heartbeatMs: 10_000, maxMs: 5_000 });
    const parser = createSseParser((e) => events.push(e));
    const reader = stream.getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(Buffer.from(value).toString('utf8'));
      }
    })();
    await new Promise((r) => setTimeout(r, 60));
    const before = events.length;
    assert.equal((await store.recordDecisionPosition(created.decision.id, 'claude', 'agree', null, THREE)).status, 'ok');
    await new Promise((r) => setTimeout(r, 80));
    const messages = events.filter((e) => e.event === 'messages').slice(1); // skip the opening batch if any
    // With since=later.id the opening batch has no messages; the position should re-send the card's message.
    const resent = events.filter((e) => e.event === 'messages').flatMap((e) => JSON.parse(e.data as string) as Message[]);
    assert.ok(resent.some((m) => m.id === created.message.id && m.decision?.positions.some((p) => p.participant === 'claude')),
      `expected the older card to be re-sent, got ${JSON.stringify(events)} (before=${before})`);
    abort.abort();
    await pump;
  });
}

test('sql: the reactor/participant column accepts any shape-valid name and refuses a name that is not one', async () => {
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  const created = must(await store.createDecision({ creator: 'david', prompt: 'Q' }));
  await pg.query(
    'INSERT INTO decision_positions (card_id, participant, stance, note) VALUES ($1, $2, $3, $4)',
    [created.decision.id, 'quill-2', 'agree', null],
  );
  await assert.rejects(
    pg.query(
      'INSERT INTO decision_positions (card_id, participant, stance, note) VALUES ($1, $2, $3, $4)',
      [created.decision.id, 'Not A Name', 'agree', null],
    ),
  );
});

test('the API takes the participant from the token and only returns the list when asked', async () => {
  const req = (path: string, init: RequestInit = {}) => new Request(`http://hub.test${path}`, init);
  const headers = { 'Content-Type': 'application/json', ...auth('david') };
  const created = await createRoute.POST(req('/api/decisions', { method: 'POST', headers, body: JSON.stringify({ prompt: 'Ship it?' }) }));
  assert.equal(created.status, 201);
  const body = await created.json() as { message: Message; decision: { id: string; positions: { participant: string; stance: string }[] } };
  assert.equal(body.message.sender, 'david');
  assert.equal(body.decision.id.startsWith('decision_'), true);
  assert.deepEqual(body.decision.positions.map((p) => [p.participant, p.stance]), [['david', 'agree']]);

  const spoof = await positionRoute.PUT(req(`/api/decisions/${body.decision.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('claude') },
    body: JSON.stringify({ stance: 'agree', participant: 'david', note: 'Yes, build it.' }),
  }), params(body.decision.id));
  assert.equal(spoof.status, 200);
  const put = await spoof.json() as { decision: { positions: { participant: string; stance: string; note: string | null }[] } };
  assert.deepEqual(put.decision.positions.map((p) => [p.participant, p.stance, p.note]), [['david', 'agree', null], ['claude', 'agree', 'Yes, build it.']]);
  assert.equal((put as { reply?: { text: string; reply_to: number } }).reply?.text, 'Agree: Yes, build it.');
  assert.equal((put as { reply?: { reply_to: number } }).reply?.reply_to, body.message.id);

  const missing = await positionRoute.PUT(req(`/api/decisions/${body.decision.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('grok') },
    body: JSON.stringify({ stance: 'object' }),
  }), params(body.decision.id));
  assert.equal(missing.status, 400);

  const plain = await messagesRoute.GET(req('/api/messages', { headers: auth('david') }));
  const plainBody = await plain.json() as { decisions?: unknown };
  assert.equal(plainBody.decisions, undefined);
  const listed = await messagesRoute.GET(req('/api/messages?decisions=1', { headers: auth('david') }));
  const listedBody = await listed.json() as { decisions: { id: string }[] };
  assert.equal(listedBody.decisions.some((c) => c.id === body.decision.id), true);
});
