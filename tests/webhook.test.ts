// Grok wake-up webhook: the signature contract, the receiver checks, and delivery (coalescing,
// retries, never dropping a wake-up). Delivery runs against the real SQL (PGlite) and the memory store.
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Sender } from '../lib/core';
import { createMemoryStore, createSqlStore, wakesGrok, type Db, type Row, type Store } from '../lib/store';
import {
  COMBINED_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, combinedSignature, createWakeup, sign, verify, webhookConfig,
  type DeliveryResult, type WakeupPayload,
} from '../lib/webhook';

// The fixed test vector published for Grok's receiver. The expected value was computed
// independently with: printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET"
const VECTOR = {
  secret: 'collab-hub-test-secret-not-a-real-one',
  timestamp: '1795620000',
  body: '{"first_id":41,"last_id":43,"count":3,"sent_at":1795620000}',
  signature: 'sha256=611271d77a83a8878ba481a060f33cc035025583a24cf07acde2ac31dc0c252a',
};

test('signature: fixed test vector', () => {
  assert.equal(sign(VECTOR.secret, VECTOR.timestamp, VECTOR.body), VECTOR.signature);
  // Signing the bytes gives the same result as signing the string.
  assert.equal(sign(VECTOR.secret, VECTOR.timestamp, new TextEncoder().encode(VECTOR.body)), VECTOR.signature);
  assert.match(VECTOR.signature, /^sha256=[0-9a-f]{64}$/);
  // The Stripe-style header carries the same timestamp and the same hex.
  assert.equal(
    combinedSignature(VECTOR.secret, VECTOR.timestamp, VECTOR.body),
    't=1795620000,v1=611271d77a83a8878ba481a060f33cc035025583a24cf07acde2ac31dc0c252a',
  );
});

test('receiver checks: accepts the vector, rejects anything else', () => {
  const now = Number(VECTOR.timestamp);
  const base = { secret: VECTOR.secret, timestamp: VECTOR.timestamp, signature: VECTOR.signature, rawBody: VECTOR.body, now };
  assert.deepEqual(verify(base), { ok: true });

  assert.equal(verify({ ...base, timestamp: null }).ok, false, 'missing timestamp header');
  assert.equal(verify({ ...base, signature: undefined }).ok, false, 'missing signature header');
  assert.equal(verify({ ...base, secret: 'another-secret-0123456789' }).ok, false, 'wrong secret');
  assert.equal(verify({ ...base, rawBody: VECTOR.body.replace('43', '44') }).ok, false, 'tampered body');
  assert.equal(verify({ ...base, rawBody: JSON.stringify(JSON.parse(VECTOR.body), null, 1) }).ok, false, 're-serialised body');
  assert.equal(verify({ ...base, signature: VECTOR.signature.toUpperCase().replace('SHA256', 'sha256') }).ok, false, 'uppercase hex');
  assert.equal(verify({ ...base, signature: VECTOR.signature.replace('sha256=', '') }).ok, false, 'no sha256= prefix');
  assert.equal(verify({ ...base, timestamp: `${VECTOR.timestamp}000` }).ok, false, 'milliseconds');
});

test('receiver checks: 5-minute window in both directions', () => {
  const t = Number(VECTOR.timestamp);
  const at = (now: number) => verify({ secret: VECTOR.secret, timestamp: VECTOR.timestamp, signature: VECTOR.signature, rawBody: VECTOR.body, now }).ok;
  assert.equal(at(t + 300), true);
  assert.equal(at(t - 300), true);
  assert.equal(at(t + 301), false, 'too old');
  assert.equal(at(t - 301), false, 'timestamp in the future');
});

test('config: off unless both the URL and the secret are usable', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const url = 'https://grok.example/wake';
    const secret = 'a-long-enough-secret-0123456789';
    assert.equal(webhookConfig({}), null);
    assert.equal(webhookConfig({ GROK_WEBHOOK_URL: url }), null);
    assert.equal(webhookConfig({ GROK_WEBHOOK_SECRET: secret }), null);
    assert.equal(webhookConfig({ GROK_WEBHOOK_URL: '', GROK_WEBHOOK_SECRET: secret }), null);
    assert.equal(webhookConfig({ GROK_WEBHOOK_URL: 'http://grok.example/wake', GROK_WEBHOOK_SECRET: secret }), null, 'http');
    assert.equal(webhookConfig({ GROK_WEBHOOK_URL: 'not a url', GROK_WEBHOOK_SECRET: secret }), null);
    assert.equal(webhookConfig({ GROK_WEBHOOK_URL: url, GROK_WEBHOOK_SECRET: 'short' }), null);
    assert.deepEqual(webhookConfig({ GROK_WEBHOOK_URL: url, GROK_WEBHOOK_SECRET: secret }), { url, secret });
  } finally {
    console.warn = warn;
  }
});

test('which messages wake Grok', () => {
  assert.equal(wakesGrok({ sender: 'david', recipient: 'grok' }), true);
  assert.equal(wakesGrok({ sender: 'claude', recipient: null }), true, 'to everyone');
  assert.equal(wakesGrok({ sender: 'david', recipient: 'claude' }), false, 'addressed to someone else');
  assert.equal(wakesGrok({ sender: 'grok', recipient: null }), false, "Grok's own post");
  assert.equal(wakesGrok({ sender: 'grok', recipient: 'grok' }), false);
  assert.equal(wakesGrok({ sender: 'hub', recipient: null }), false, 'seeded welcome');
});

// --- delivery ---------------------------------------------------------------------------------

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

const CONFIG = { url: 'https://grok.example/wake', secret: 'delivery-test-secret-0123456789' };
const NOW_MS = 1_795_620_000_000;

interface Call { url: string; headers: Record<string, string>; body: string; redirect?: string }
type Reply = number | 'throw' | 'hang';

/** A fetch stand-in: records every call and answers from a script (default 200). */
function fakeFetch(script: Reply[] = []) {
  const calls: Call[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body), redirect: init?.redirect });
    const reply = script.shift() ?? 200;
    if (reply === 'throw') throw new TypeError('fetch failed');
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    }
    return new Response(null, { status: reply });
  };
  return { calls, fetch: impl as typeof fetch };
}

function setup(store: Store, script: Reply[] = []) {
  const f = fakeFetch(script);
  const wakeup = createWakeup({ store, config: CONFIG, fetch: f.fetch, now: () => NOW_MS, debounceMs: 20, timeoutMs: 40, retryDelaysMs: [5, 10] });
  /** Stores a message and triggers the wake-up, as the POST route does. */
  const post = async (sender: Sender, recipient: Sender | null, text = 'hi') => {
    const message = await store.add({ sender, recipient, text });
    assert.ok(message);
    return { message, job: wakeup.onMessage(message) };
  };
  return { ...f, wakeup, post };
}

const payloadOf = (call: Call) => JSON.parse(call.body) as WakeupPayload;
const settle = (jobs: (Promise<DeliveryResult> | null)[]) => Promise.all(jobs.filter((j) => j !== null));

let errorLog: unknown[][] = [];
const realError = console.error;
beforeEach(() => { errorLog = []; console.error = (...args: unknown[]) => { errorLog.push(args); }; });
afterEach(() => { console.error = realError; vi.restoreAllMocks(); });

const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];

for (const [name, make] of STORES) {
  test(`${name}: a burst becomes one delivery with a thin, signed payload`, async () => {
    const store = await make();
    const { calls, post } = setup(store);
    const a = await post('david', null, 'SECRET-TEXT-ONE');
    const b = await post('claude', 'grok', 'SECRET-TEXT-TWO');
    const c = await post('david', 'grok', 'SECRET-TEXT-THREE');
    const results = await settle([a.job, b.job, c.job]);

    assert.equal(calls.length, 1, 'one webhook for the burst');
    assert.deepEqual(results.map((r) => r.status).sort(), ['covered', 'covered', 'delivered']);

    const [call] = calls;
    assert.equal(call.url, CONFIG.url);
    assert.equal(call.redirect, 'manual');
    // Exactly these headers, with exactly these names.
    assert.deepEqual(Object.keys(call.headers).sort(), ['Content-Type', COMBINED_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER].sort());
    assert.equal(COMBINED_HEADER, 'X-Hub-Grok-Signature');
    assert.equal(
      call.headers[COMBINED_HEADER],
      `t=${call.headers[TIMESTAMP_HEADER]},v1=${call.headers[SIGNATURE_HEADER].replace('sha256=', '')}`,
      'same timestamp and same hex as the two separate headers',
    );
    assert.equal(SIGNATURE_HEADER, 'X-Hub-Signature');
    assert.equal(TIMESTAMP_HEADER, 'X-Hub-Timestamp');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers[TIMESTAMP_HEADER], '1795620000', 'Unix seconds, not milliseconds');

    // Thin payload: ids only, no message text.
    const payload = payloadOf(call);
    assert.deepEqual(payload, { first_id: a.message.id, last_id: c.message.id, count: 3, sent_at: 1795620000 });
    assert.ok(!call.body.includes('SECRET-TEXT'), 'no message text in the payload');
    assert.ok(!call.body.includes(CONFIG.secret));

    // The receiver's checks pass on the raw body as sent.
    assert.deepEqual(
      verify({ secret: CONFIG.secret, timestamp: call.headers[TIMESTAMP_HEADER], signature: call.headers[SIGNATURE_HEADER], rawBody: call.body, now: 1795620000 }),
      { ok: true },
    );
  });

  test(`${name}: a message after a delivery gets its own delivery (nothing is dropped)`, async () => {
    const store = await make();
    const { calls, post } = setup(store);
    const first = await post('david', 'grok');
    await settle([first.job]);
    const second = await post('claude', null);
    const [result] = await settle([second.job]);
    assert.equal(result.status, 'delivered');
    assert.equal(calls.length, 2);
    assert.deepEqual(payloadOf(calls[1]), { first_id: second.message.id, last_id: second.message.id, count: 1, sent_at: 1795620000 });
  });

  test(`${name}: only messages for Grok or everyone trigger, never Grok's own`, async () => {
    const store = await make();
    const { calls, post } = setup(store);
    const own = await post('grok', null, "Grok's own post");
    const other = await post('david', 'claude', 'for Claude only');
    assert.equal(own.job, null);
    assert.equal(other.job, null);
    // A later qualifying message covers only itself, not the two above.
    const real = await post('claude', 'grok');
    await settle([real.job]);
    assert.equal(calls.length, 1);
    assert.deepEqual(payloadOf(calls[0]), { first_id: real.message.id, last_id: real.message.id, count: 1, sent_at: 1795620000 });
  });

  test(`${name}: retries, then succeeds with identical bytes`, async () => {
    const store = await make();
    const { calls, post } = setup(store, [500, 'throw', 200]);
    const m = await post('david', 'grok');
    const [result] = await settle([m.job]);
    assert.deepEqual(result, { status: 'delivered', attempts: 3, claim: { first_id: m.message.id, last_id: m.message.id, count: 1, previous_id: 0 } });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].body, calls[0].body);
    assert.deepEqual(calls[2].headers, calls[0].headers);
    // Delivered, so the range is not sent again.
    assert.equal(await store.claimWakeup(), null);
  });

  test(`${name}: after the last retry fails, the range is re-sent with the next message`, async () => {
    const store = await make();
    const { calls, post } = setup(store, [500, 302, 'hang']);
    const lost = await post('david', 'grok');
    const [failed] = await settle([lost.job]);
    assert.equal(failed.status, 'failed');
    assert.equal(calls.length, 3, 'one attempt plus two retries (a redirect and a timeout count as failures)');
    // The failure is logged with the ids and without the secret.
    const logged = errorLog.flat().join(' ');
    assert.match(logged, new RegExp(`#${lost.message.id}`));
    assert.ok(!logged.includes(CONFIG.secret));

    const next = await post('claude', null);
    const [result] = await settle([next.job]);
    assert.equal(result.status, 'delivered');
    assert.deepEqual(payloadOf(calls[3]), { first_id: lost.message.id, last_id: next.message.id, count: 2, sent_at: 1795620000 });
  });

  test(`${name}: a failed claim is not put back once a later claim has moved on`, async () => {
    const store = await make();
    await store.add({ sender: 'david', recipient: 'grok', text: 'one' });
    const first = await store.claimWakeup();
    assert.ok(first);
    await store.add({ sender: 'david', recipient: 'grok', text: 'two' });
    const second = await store.claimWakeup();
    assert.ok(second);
    assert.equal(second.previous_id, first.last_id);
    assert.equal(await store.releaseWakeup(first), false, 'the watermark has moved on');
    assert.equal(await store.claimWakeup(), null);
    assert.equal(await store.releaseWakeup(second), true);
    assert.deepEqual(await store.claimWakeup(), second, 'the released range can be claimed again');
  });
}

test('history from before the webhook existed never triggers a wake-up', async () => {
  // An existing v1 database: messages first, webhook_state created afterwards.
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT, text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), pinned_at TIMESTAMPTZ);
    INSERT INTO messages (sender, text) VALUES ('hub', 'welcome'), ('david', 'old one'), ('claude', 'old two');`);
  const store = createSqlStore(pgliteDb(pg));
  assert.equal(await store.claimWakeup(), null);
  const fresh = await store.add({ sender: 'david', recipient: null, text: 'new' });
  assert.ok(fresh);
  assert.deepEqual(await store.claimWakeup(), { first_id: fresh.id, last_id: fresh.id, count: 1, previous_id: fresh.id - 1 });
});

test('a job never rejects, even when the store fails', async () => {
  const store = createMemoryStore();
  store.claimWakeup = async () => { throw new Error('database is down'); };
  const { wakeup } = setup(store);
  const job = wakeup.onMessage({ sender: 'david', recipient: 'grok' });
  assert.ok(job);
  assert.deepEqual(await job, { status: 'error', error: 'Error: database is down' });
});

test('over real HTTP: the receiver gets the exact headers and bytes, and a 503 is retried', async (ctx) => {
  const { createServer } = await import('node:http');
  const { createHmac } = await import('node:crypto');
  const received: { headers: Record<string, string | string[] | undefined>; raw: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
      res.statusCode = received.length === 1 ? 503 : 204;
      res.end();
    });
  });
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false)); // sandboxes without local ports
    server.listen(0, '127.0.0.1', () => resolve(true));
  });
  if (!listening) return ctx.skip();
  try {
    const { port } = server.address() as { port: number };
    const store = createMemoryStore();
    const config = { url: `http://127.0.0.1:${port}/wake`, secret: CONFIG.secret }; // bypasses webhookConfig's https rule on purpose
    const wakeup = createWakeup({ store, config, debounceMs: 10, timeoutMs: 2000, retryDelaysMs: [10, 10] });
    const message = await store.add({ sender: 'david', recipient: 'grok', text: 'over the wire' });
    assert.ok(message);
    const result = await wakeup.onMessage(message);
    assert.equal(result?.status, 'delivered');
    assert.equal(received.length, 2, 'the 503 was retried');

    for (const { headers, raw } of received) {
      const timestamp = headers['x-hub-timestamp'] as string;
      const signature = headers['x-hub-signature'] as string;
      assert.equal(headers['content-type'], 'application/json');
      assert.equal(headers['x-hub-signature-256'], undefined);
      assert.match(timestamp, /^\d{10}$/);
      // An independent receiver: HMAC over the ASCII timestamp, a dot, and the raw bytes received.
      const expected = 'sha256=' + createHmac('sha256', CONFIG.secret).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), raw])).digest('hex');
      assert.equal(signature, expected);
      assert.equal(headers['x-hub-grok-signature'], `t=${timestamp},v1=${expected.slice(7)}`);
      assert.deepEqual(verify({ secret: CONFIG.secret, timestamp, signature, rawBody: raw }), { ok: true });
      assert.deepEqual(Object.keys(JSON.parse(raw.toString('utf8')) as object), ['first_id', 'last_id', 'count', 'sent_at']);
    }
    assert.ok(received[0].raw.equals(received[1].raw), 'identical bytes on the retry');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
