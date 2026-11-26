// Grok wake-up webhook: the signature contract, the receiver checks, and delivery (coalescing,
// retries, never dropping a wake-up). Delivery runs against the real SQL (PGlite) and the memory store.
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Sender } from '../lib/core';
import { createMemoryStore, createSqlStore, WAKE_SENDING_STALE_MS, wakesGrok, type Db, type Row, type Store } from '../lib/store';
import {
  COMBINED_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, combinedSignature, createWakeup, setWakeDnsForTests, sign, verify, wakeupPayload, webhookConfig,
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

test('wakeupPayload sets needs_pin_title only when asked', () => {
  const base = { id: 107, sender: 'david', recipient: null, text: 'The board, redrawn.', room: 'main' };
  const ordinary = wakeupPayload(base, ['grok', 'claude', 'david'], 1795620000);
  assert.equal('needs_pin_title' in ordinary, false);
  const title = wakeupPayload({ ...base, needs_pin_title: true }, ['grok', 'claude', 'david'], 1795620000);
  assert.equal(title.needs_pin_title, true);
  assert.equal(title.id, 107);
});

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

function setup(store: Store, script: Reply[] = [], targets: Record<string, { url: string; secret: string }> = { grok: CONFIG }) {
  const f = fakeFetch(script);
  const wakeup = createWakeup({
    store,
    fallbackTargets: targets,
    fetch: f.fetch,
    now: () => NOW_MS,
    debounceMs: 20,
    timeoutMs: 40,
    retryDelaysMs: [5],
  });
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
beforeEach(() => { errorLog = []; console.error = (...args: unknown[]) => { errorLog.push(args); }; setWakeDnsForTests(async () => [{ address: '93.184.216.34', family: 4 }]); });
afterEach(() => { console.error = realError; setWakeDnsForTests(null); vi.restoreAllMocks(); });

const STORES: [string, () => Promise<Store>][] = [
  ['sql (PGlite)', async () => createSqlStore(pgliteDb(new PGlite()))],
  ['memory', async () => createMemoryStore()],
];

for (const [name, make] of STORES) {
  test(`${name}: a burst is one signed POST per message, after one debounce`, async () => {
    const store = await make();
    const { calls, post } = setup(store);
    const a = await post('david', null, 'A note about storage.');
    const b = await post('claude', 'grok', 'Agreed, I think.');
    const c = await post('david', 'grok', 'Please take a look.');
    const results = await settle([a.job, b.job, c.job]);

    assert.equal(calls.length, 3, 'one webhook per message, not one for the burst');
    assert.deepEqual(results.map((r) => r.status).sort(), ['delivered', 'idle', 'idle']);

    const [call] = calls;
    assert.equal(call.url, CONFIG.url);
    assert.equal(call.redirect, 'manual');
    assert.deepEqual(Object.keys(call.headers).sort(), ['Content-Type', COMBINED_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER].sort());
    assert.equal(COMBINED_HEADER, 'X-Hub-Grok-Signature');
    assert.equal(
      call.headers[COMBINED_HEADER],
      `t=${call.headers[TIMESTAMP_HEADER]},v1=${call.headers[SIGNATURE_HEADER].replace('sha256=', '')}`,
      'same timestamp and same hex as the two separate headers',
    );
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers[TIMESTAMP_HEADER], '1795620000', 'Unix seconds, not milliseconds');

    const payload = payloadOf(call);
    assert.equal(payload.id, a.message.id);
    assert.equal(payload.sender, 'david');
    assert.ok(payload.recipients.includes('grok') && payload.recipients.includes('claude'));
    assert.equal(payload.preview, 'A note about storage.');
    assert.deepEqual({ first_id: payload.first_id, last_id: payload.last_id, count: payload.count, sent_at: payload.sent_at }, {
      first_id: a.message.id, last_id: a.message.id, count: 1, sent_at: 1795620000,
    });
    assert.ok(!call.body.includes(CONFIG.secret));

    assert.deepEqual(
      verify({ secret: CONFIG.secret, timestamp: call.headers[TIMESTAMP_HEADER], signature: call.headers[SIGNATURE_HEADER], rawBody: call.body, now: 1795620000 }),
      { ok: true },
    );

    const wakes = await store.listWakes([a.message.id, b.message.id, c.message.id]);
    assert.deepEqual(wakes.map((w) => [w.message_id, w.participant, w.status]), [
      [a.message.id, 'grok', 'delivered'],
      [b.message.id, 'grok', 'delivered'],
      [c.message.id, 'grok', 'delivered'],
    ]);
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
    assert.equal(payloadOf(calls[1]).id, second.message.id);
    assert.equal(payloadOf(calls[1]).count, 1);
  });

  test(`${name}: a message from the human wakes every agent with a target, whoever it is addressed to`, async () => {
    const store = await make();
    const { calls, post } = setup(store); // only grok has a target
    const toClaude = await post('david', 'claude', 'for the other agent only');
    assert.ok(toClaude.job, 'the human still wakes grok, even when the message is addressed to someone else');
    await settle([toClaude.job]);
    assert.equal(calls.length, 1);
    assert.equal(payloadOf(calls[0]).id, toClaude.message.id);
    assert.deepEqual(payloadOf(calls[0]).recipients, ['claude']);

    const own = await post('grok', null, "an agent's own post to everyone");
    // Addressed to everyone, but never the sender: this would wake the other agent, who has no target.
    const [idle] = await settle([own.job]);
    assert.equal(idle.status, 'idle');
    assert.equal(calls.length, 1);
  });

  test(`${name}: an agent-to-agent message wakes only the agent it addresses, never the sender`, async () => {
    const quill = { url: 'https://quill.example/wake', secret: 'quill-test-secret-0123456789' };
    const store = await make();
    const { calls, post } = setup(store, [], { grok: CONFIG, claude: quill });
    const toGrok = await post('claude', 'grok', 'a question for one agent');
    await settle([toGrok.job]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CONFIG.url);
    assert.deepEqual(payloadOf(calls[0]).recipients, ['grok']);

    const toHuman = await post('claude', 'david', 'only for the human');
    assert.equal(toHuman.job, null, 'an agent writing to the human wakes no agent');
    assert.equal(calls.length, 1);
  });

  test(`${name}: retries once, then succeeds with identical bytes`, async () => {
    const store = await make();
    const { calls, post } = setup(store, [500, 200]);
    const m = await post('david', 'grok');
    const [result] = await settle([m.job]);
    assert.equal(result.status, 'delivered');
    assert.equal(calls.length, 2, 'the first try and one retry');
    assert.equal(calls[1].body, calls[0].body);
    assert.deepEqual(calls[1].headers, calls[0].headers);
    const [row] = await store.listWakes([m.message.id]);
    assert.equal(row.status, 'delivered');
    assert.equal(row.attempts, 2);
  });

  test(`${name}: after the retry fails, the delivery is recorded as failed and is not sent again with the next message`, async () => {
    const store = await make();
    const { calls, post } = setup(store, [500, 'hang', 200]);
    const lost = await post('david', 'grok');
    const [failed] = await settle([lost.job]);
    assert.equal(failed.status, 'failed');
    assert.equal(calls.length, 2, 'one attempt plus one retry (a timeout counts as a failure)');
    const logged = errorLog.flat().join(' ');
    assert.match(logged, new RegExp(`#${lost.message.id}`));
    assert.ok(!logged.includes(CONFIG.secret));
    assert.ok(!logged.includes(CONFIG.url), 'the target URL is not logged');

    const [row] = await store.listWakes([lost.message.id]);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 2);
    assert.ok(row.error);
    assert.ok(!row.error.includes(CONFIG.secret));

    const next = await post('claude', null);
    const [result] = await settle([next.job]);
    assert.equal(result.status, 'delivered');
    assert.equal(calls.length, 3, 'only the new message is sent, not the failed one again');
    assert.equal(payloadOf(calls[2]).id, next.message.id);
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

  test(`${name}: listWakeTargets returns updated_at as ISO 8601`, async () => {
    const store = await make();
    await store.setWakeTarget('grok', CONFIG.url, CONFIG.secret);
    const [row] = await store.listWakeTargets();
    assert.equal(row.participant, 'grok');
    assert.equal(row.url, CONFIG.url);
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test(`${name}: two delivery jobs never send the same wake twice`, async () => {
    const store = await make();
    const message = await store.add({ sender: 'david', recipient: 'grok', text: 'only once' });
    assert.ok(message);
    await store.enqueueWakes(message.id, ['grok']);
    const a = setup(store);
    const b = setup(store);
    // onMessage enqueues again (no-op) and both run deliver; only one should claim the row.
    await settle([a.wakeup.onMessage(message), b.wakeup.onMessage(message)]);
    const sent = [...a.calls, ...b.calls];
    assert.equal(sent.length, 1, 'exactly one signed POST');
    assert.equal(JSON.parse(sent[0].body).id, message.id);
    const [row] = await store.listWakes([message.id]);
    assert.equal(row.status, 'delivered');
  });

  test(`${name}: a name that rebinds to an internal address is not contacted`, async () => {
    const store = await make();
    setWakeDnsForTests(async () => [{ address: '10.0.0.9', family: 4 }]);
    const { calls, post } = setup(store);
    const sent = await post('david', 'grok', 'should not leave the hub');
    const [result] = await settle([sent.job]);
    assert.equal(result.status, 'failed');
    assert.equal(calls.length, 0, 'no request is sent');
    const [row] = await store.listWakes([sent.message.id]);
    assert.equal(row.status, 'failed');
    assert.match(String(row.error), /internal address/);
    assert.ok(!String(row.error).includes('10.0.0.9'));
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
  store.enqueueWakes = async () => { throw new Error('database is down'); };
  const { wakeup } = setup(store);
  const job = wakeup.onMessage({ id: 1, sender: 'david', recipient: 'grok', text: 'hi' });
  assert.ok(job);
  assert.deepEqual(await job, { status: 'error', error: 'Error: database is down' });
});

test('a sending claim is taken again after a minute, and not before', async () => {
  let now = 1_000_000;
  const store = createMemoryStore({ now: () => now });
  const message = await store.add({ sender: 'david', recipient: 'grok', text: 'claim me' });
  assert.ok(message);
  await store.enqueueWakes(message.id, ['grok']);
  const first = await store.claimPendingWakes();
  assert.equal(first.length, 1);
  assert.equal(first[0].message_id, message.id);
  assert.deepEqual(await store.claimPendingWakes(), [], 'still sending, not yet stale');
  now += WAKE_SENDING_STALE_MS - 1;
  assert.deepEqual(await store.claimPendingWakes(), [], 'just under a minute');
  now += 2;
  const again = await store.claimPendingWakes();
  assert.equal(again.length, 1);
  assert.equal(again[0].message_id, message.id);
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
    const fallbackTargets = { grok: { url: `http://127.0.0.1:${port}/wake`, secret: CONFIG.secret } }; // bypasses https on purpose
    const wakeup = createWakeup({ store, fallbackTargets, debounceMs: 10, timeoutMs: 2000, retryDelaysMs: [10], enforcePublicTarget: false });
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
      const expected = 'sha256=' + createHmac('sha256', CONFIG.secret).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), raw])).digest('hex');
      assert.equal(signature, expected);
      assert.equal(headers['x-hub-grok-signature'], `t=${timestamp},v1=${expected.slice(7)}`);
      assert.deepEqual(verify({ secret: CONFIG.secret, timestamp, signature, rawBody: raw }), { ok: true });
      const body = JSON.parse(raw.toString('utf8')) as WakeupPayload;
      assert.equal(body.id, message.id);
      assert.equal(body.sender, 'david');
      assert.deepEqual(body.recipients, ['grok']);
      assert.equal(body.preview, 'over the wire');
      assert.equal(body.first_id, message.id);
      assert.equal(body.count, 1);
    }
    assert.ok(received[0].raw.equals(received[1].raw), 'identical bytes on the retry');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
