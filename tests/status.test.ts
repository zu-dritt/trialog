// Tests for participant "Thinking…" status: input parsing, store (PGlite + memory), and API route.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  STATUS_DEFAULT_TTL_SECONDS, STATUS_MAX_LENGTH, STATUS_MAX_TTL_SECONDS, STATUS_MIN_TTL_SECONDS,
  parseStatusInput, type ParticipantStatus,
} from '../lib/core';
import { createMemoryStore, createSqlStore, type Db, type Row } from '../lib/store';

const TOKENS: Record<string, string> = {
  grok: 'grok-status-token-0123456789abcdef',
  claude: 'claude-status-token-0123456789abcd',
  david: 'david-status-token-0123456789abcdef',
};

type Handler = (request: Request) => Promise<Response>;
let route: { GET: Handler; PUT: Handler; DELETE: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  route = (await import('../app/api/status/route')) as unknown as typeof route;
});

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

test('parseStatusInput trims text, enforces 1–80 chars, and clamps TTL to 30–1800 s', () => {
  assert.deepEqual(parseStatusInput({ text: '  reviewing\nPR #7\t ' }), {
    ok: true,
    text: 'reviewing PR #7',
    ttlSeconds: STATUS_DEFAULT_TTL_SECONDS,
  });
  assert.deepEqual(parseStatusInput({ text: 'a'.repeat(STATUS_MAX_LENGTH), ttlSeconds: 5 }), {
    ok: true,
    text: 'a'.repeat(STATUS_MAX_LENGTH),
    ttlSeconds: STATUS_MIN_TTL_SECONDS,
  });
  assert.deepEqual(parseStatusInput({ text: 'thinking', ttlSeconds: 9999 }), {
    ok: true,
    text: 'thinking',
    ttlSeconds: STATUS_MAX_TTL_SECONDS,
  });
  assert.deepEqual(parseStatusInput({ text: 'thinking', ttlSeconds: 600.4 }), {
    ok: true,
    text: 'thinking',
    ttlSeconds: 600,
  });
  assert.equal(parseStatusInput(null).ok, false);
  assert.equal(parseStatusInput([]).ok, false);
  assert.equal(parseStatusInput({ text: '   ' }).ok, false);
  assert.equal(parseStatusInput({ text: 'a'.repeat(81) }).ok, false);
  assert.equal(parseStatusInput({ text: 'ok\u0000' }).ok, false);
  assert.equal(parseStatusInput({ text: 'ok', ttlSeconds: '600' }).ok, false);
  assert.equal(parseStatusInput({ text: 'ok', ttlSeconds: Number.NaN }).ok, false);
});

test('memory store: set, replace, clear and expire statuses using clock', async () => {
  let nowMs = Date.parse('2026-11-26T04:00:00.000Z');
  const store = createMemoryStore({ now: () => nowMs });
  assert.deepEqual(await store.listStatuses(), []);

  await store.setStatus({ participant: 'grok', text: 'reviewing PR #7', ttlSeconds: 60 });
  nowMs += 1000;
  await store.setStatus({ participant: 'claude', text: 'writing tests', ttlSeconds: 300 });
  const active = await store.listStatuses();
  assert.deepEqual(active.map((s) => s.participant), ['claude', 'grok']);

  // Grok's 60 s status expires while Claude's 300 s status remains active.
  nowMs += 60_000;
  const afterExpiry = await store.listStatuses();
  assert.deepEqual(afterExpiry.map((s) => s.participant), ['claude']);

  assert.equal(await store.clearStatus('claude'), true);
  assert.equal(await store.clearStatus('claude'), false);
  assert.deepEqual(await store.listStatuses(), []);
});

test('sql (PGlite): set, clear, expiry cleanup and CHECK constraints', async () => {
  const pg = new PGlite();
  const store = createSqlStore(pgliteDb(pg));
  await store.ensure();

  const s1 = await store.setStatus({ participant: 'grok', text: 'first', ttlSeconds: 120 });
  assert.equal(s1.participant, 'grok');
  const s2 = await store.setStatus({ participant: 'grok', text: 'updated', ttlSeconds: 300 });
  assert.equal(s2.text, 'updated');
  await store.setStatus({ participant: 'david', text: 'testing locally', ttlSeconds: 300 });

  let list = await store.listStatuses();
  assert.equal(list.length, 2);

  // Simulate expiry of Grok's row directly in Postgres and verify lazy cleanup + exclusion.
  await pg.query("UPDATE participant_status SET expires_at = now() - interval '1 second' WHERE participant = 'grok'");
  list = await store.listStatuses();
  assert.deepEqual(list.map((s) => s.participant), ['david']);
  const remaining = await pg.query("SELECT participant FROM participant_status");
  assert.equal(remaining.rows.length, 1);

  assert.equal(await store.clearStatus('david'), true);
  assert.equal(await store.clearStatus('david'), false);

  // Who is a participant is the application's business (PARTICIPANTS); the table refuses what could never be a name.
  await assert.rejects(store.setStatus({ participant: 'Not A Name', text: 'x', ttlSeconds: 60 }));
  assert.ok(await store.setStatus({ participant: 'quill-2', text: 'a fourth participant', ttlSeconds: 60 }));
  await assert.rejects(store.setStatus({ participant: 'grok', text: '', ttlSeconds: 60 }));
  await assert.rejects(store.setStatus({ participant: 'grok', text: 'x'.repeat(81), ttlSeconds: 60 }));
});

const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});

test('API /api/status: 401 without valid token', async () => {
  for (const who of [undefined, 'wrong-token-0123456789abcdef']) {
    assert.equal((await route.GET(new Request('http://hub.test/api/status', { headers: auth(who) }))).status, 401);
    assert.equal((await route.PUT(new Request('http://hub.test/api/status', { method: 'PUT', headers: auth(who), body: JSON.stringify({ text: 'hi' }) }))).status, 401);
    assert.equal((await route.DELETE(new Request('http://hub.test/api/status', { method: 'DELETE', headers: auth(who) }))).status, 401);
  }
});

test('API /api/status: own-only updates, clamping, validation, and clear', async () => {
  // Caller cannot spoof participant/sender in body.
  const putGrok = await route.PUT(new Request('http://hub.test/api/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('grok') },
    body: JSON.stringify({ text: '  reviewing PR #7  ', participant: 'david', sender: 'claude', ttlSeconds: 5 }),
  }));
  assert.equal(putGrok.status, 200);
  const grokBody = (await putGrok.json()) as { status: ParticipantStatus };
  assert.equal(grokBody.status.participant, 'grok');
  assert.equal(grokBody.status.text, 'reviewing PR #7');
  const grokTtl = Math.round((Date.parse(grokBody.status.expires_at) - Date.parse(grokBody.status.updated_at)) / 1000);
  assert.equal(grokTtl, 30);

  const putClaude = await route.PUT(new Request('http://hub.test/api/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth('claude') },
    body: JSON.stringify({ text: 'building composer', ttlSeconds: 9999 }),
  }));
  assert.equal(putClaude.status, 200);
  const claudeBody = (await putClaude.json()) as { status: ParticipantStatus };
  const claudeTtl = Math.round((Date.parse(claudeBody.status.expires_at) - Date.parse(claudeBody.status.updated_at)) / 1000);
  assert.equal(claudeTtl, 1800);

  const getAll = await route.GET(new Request('http://hub.test/api/status', { headers: auth('david') }));
  assert.equal(getAll.status, 200);
  const { statuses } = (await getAll.json()) as { statuses: ParticipantStatus[] };
  assert.equal(statuses.length, 2);

  // Validation failures.
  assert.equal((await route.PUT(new Request('http://hub.test/api/status', {
    method: 'PUT', headers: auth('grok'), body: JSON.stringify({ text: '' }),
  }))).status, 400);
  assert.equal((await route.PUT(new Request('http://hub.test/api/status', {
    method: 'PUT', headers: auth('grok'), body: JSON.stringify({ text: 'x'.repeat(81) }),
  }))).status, 400);
  assert.equal((await route.PUT(new Request('http://hub.test/api/status', {
    method: 'PUT', headers: auth('grok'), body: 'not-json',
  }))).status, 400);
  assert.equal((await route.PUT(new Request('http://hub.test/api/status', {
    method: 'PUT', headers: auth('grok'), body: JSON.stringify({ text: 'x', pad: 'y'.repeat(5000) }),
  }))).status, 413);

  // DELETE clears only caller's own status.
  const delGrok = await route.DELETE(new Request('http://hub.test/api/status', { method: 'DELETE', headers: auth('grok') }));
  assert.deepEqual(await delGrok.json(), { cleared: true });
  const afterDel = (await (await route.GET(new Request('http://hub.test/api/status', { headers: auth('david') }))).json()) as { statuses: ParticipantStatus[] };
  assert.deepEqual(afterDel.statuses.map((s) => s.participant), ['claude']);
});
