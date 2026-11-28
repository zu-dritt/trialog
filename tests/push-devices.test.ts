// Registration of iPhone device tokens, the APNs no-op when no key is set, and
// disabling a device when Apple answers 410. Tokens and keys must never appear in logs.
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { Message } from '../lib/core';
import { resetApnsForTests, setApnsTransportForTests, signApnsJwt, type ApnsResponse, type ApnsTransport } from '../lib/apns';
import {
  DEFAULT_BUNDLE_ID,
  humansForCard,
  humansForFlight,
  humansForMessage,
  notifyPushForFlight,
  notifyPushForMessage,
  parsePushDevice,
  pushAlertForMessage,
} from '../lib/push';
import type { RoadmapItem } from '../lib/roadmap';
import { getStore } from '../lib/store';

const TOKENS = {
  ana: 'ana-test-token-0123456789abcd',
  scout: 'scout-test-token-0123456789ab',
};
const DEVICE = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);
const BASE = 'http://hub.test';
type Handler = (request: Request) => Promise<Response>;
let register: Handler;
let unregister: Handler;
let testP8: string;

const calls: { host: string; path: string; headers: Record<string, string>; body: string }[] = [];
let nextResponse: ApnsResponse = { status: 200 };
const transport: ApnsTransport = {
  async post(opts) {
    calls.push(opts);
    return nextResponse;
  },
};

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.PARTICIPANTS = 'ana:human,scout:agent';
  process.env.ANA_TOKEN = TOKENS.ana;
  process.env.SCOUT_TOKEN = TOKENS.scout;
  delete process.env.APNS_KEY_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.APNS_KEY_P8;
  delete process.env.APNS_BUNDLE_ID;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  testP8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  ({ POST: register, DELETE: unregister } = (await import('../app/api/push/devices/route')) as unknown as { POST: Handler; DELETE: Handler });
});

afterEach(() => {
  calls.length = 0;
  nextResponse = { status: 200 };
  resetApnsForTests();
  delete process.env.APNS_KEY_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.APNS_KEY_P8;
  delete process.env.APNS_BUNDLE_ID;
});

afterAll(() => {
  delete process.env.PARTICIPANTS;
  delete process.env.ANA_TOKEN;
  delete process.env.SCOUT_TOKEN;
  resetApnsForTests();
});

const auth = (who: keyof typeof TOKENS) => ({ Authorization: `Bearer ${TOKENS[who]}` });
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

function noLeak(value: unknown, ...secrets: string[]) {
  const dumped = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret) assert.ok(!dumped.includes(secret), 'a response or payload leaked a secret');
  }
}

function messageTo(recipient: 'ana' | 'scout' | null, id = 7): Message {
  return {
    id,
    sender: 'scout',
    recipient,
    text: 'can you look at this?',
    created_at: '2026-11-28T06:00:00.000Z',
    pinned_at: null,
    room: 'main',
    attachments: [],
    reply_to: null,
    poll: null,
    decision: null,
    reactions: [],
  };
}

test('register requires a bearer token', async () => {
  const res = await register(new Request(`${BASE}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: DEVICE, platform: 'ios', env: 'sandbox' }),
  }));
  assert.equal(res.status, 401);
});

test('register upserts, defaults the topic, and re-enables a disabled token', async () => {
  const post = await register(new Request(`${BASE}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('ana') },
    body: JSON.stringify({ token: DEVICE, platform: 'ios', env: 'sandbox' }),
  }));
  assert.equal(post.status, 200);
  const first = (await bodyOf(post)).device as { participant: string; bundle_id: string; env: string; last_seen_at: string; created_at: string };
  assert.equal(first.participant, 'ana');
  assert.equal(first.bundle_id, DEFAULT_BUNDLE_ID);
  assert.equal(first.env, 'sandbox');

  const again = await register(new Request(`${BASE}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('ana') },
    body: JSON.stringify({ token: DEVICE, platform: 'ios', env: 'production', bundle_id: 'dev.trialog.app.test' }),
  }));
  assert.equal(again.status, 200);
  const second = (await bodyOf(again)).device as { bundle_id: string; env: string; created_at: string; last_seen_at: string };
  assert.equal(second.bundle_id, 'dev.trialog.app.test');
  assert.equal(second.env, 'production');
  assert.equal(second.created_at, first.created_at);
  assert.ok(second.last_seen_at >= first.last_seen_at);

  const store = await getStore();
  await store.disablePushDevice(DEVICE);
  assert.equal((await store.listPushDevices('ana')).some((d) => d.token === DEVICE), false);

  const revived = await register(new Request(`${BASE}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('ana') },
    body: JSON.stringify({ token: DEVICE, platform: 'ios', env: 'sandbox', bundle_id: 'dev.trialog.app.test' }),
  }));
  assert.equal(revived.status, 200);
  const devices = await store.listPushDevices('ana');
  assert.equal(devices.find((d) => d.token === DEVICE)?.disabled_at, null);
  assert.equal(devices.find((d) => d.token === DEVICE)?.bundle_id, 'dev.trialog.app.test');

  const gone = await unregister(new Request(`${BASE}/api/push/devices`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...auth('scout') },
    body: JSON.stringify({ token: DEVICE }),
  }));
  assert.equal(gone.status, 200);
  assert.equal((await bodyOf(gone)).deleted, false, 'another participant cannot unregister this token');

  const deleted = await unregister(new Request(`${BASE}/api/push/devices`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...auth('ana') },
    body: JSON.stringify({ token: DEVICE }),
  }));
  assert.equal((await bodyOf(deleted)).deleted, true);
  assert.equal((await store.listPushDevices('ana')).some((d) => d.token === DEVICE), false);
});

test('a bad body is 400, and APNS_BUNDLE_ID is the default topic when set', async () => {
  const bad = await register(new Request(`${BASE}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('ana') },
    body: JSON.stringify({ token: 'not-a-token', platform: 'ios', env: 'sandbox' }),
  }));
  assert.equal(bad.status, 400);

  process.env.APNS_BUNDLE_ID = 'dev.trialog.app.test';
  const parsed = parsePushDevice({ token: DEVICE_B, platform: 'ios', env: 'sandbox' });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.bundle_id, 'dev.trialog.app.test');
});

test('with no APNs key set, sending no-ops and the device stays registered', async () => {
  const store = await getStore();
  await store.upsertPushDevice({ participant: 'ana', token: DEVICE_B, platform: 'ios', env: 'sandbox', bundle_id: 'dev.trialog.app.test' });
  setApnsTransportForTests(transport);
  await notifyPushForMessage(store, messageTo('ana', 11));
  assert.equal(calls.length, 0);
  assert.equal((await store.listPushDevices('ana')).some((d) => d.token === DEVICE_B), true);
  await store.deletePushDevice('ana', DEVICE_B);
});

test('a 410 from Apple disables the device; the topic and host come from the device', async () => {
  const store = await getStore();
  const token = 'c'.repeat(64);
  await store.upsertPushDevice({ participant: 'ana', token, platform: 'ios', env: 'sandbox', bundle_id: 'dev.trialog.app.test' });
  process.env.APNS_KEY_ID = 'TESTKEYID1';
  process.env.APNS_TEAM_ID = 'TESTTEAM01';
  process.env.APNS_KEY_P8 = testP8;
  setApnsTransportForTests(transport);
  nextResponse = { status: 410, reason: 'Unregistered' };
  await notifyPushForMessage(store, messageTo('ana', 12));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'api.sandbox.push.apple.com');
  assert.equal(calls[0].headers['apns-topic'], 'dev.trialog.app.test');
  assert.ok(calls[0].path.endsWith(token));
  const payload = JSON.parse(calls[0].body) as { aps: { alert: string }; message_id: number };
  assert.match(payload.aps.alert, /Scout: can you look at this\? \(#12\)/);
  assert.equal(payload.message_id, 12);
  noLeak(calls[0].headers, testP8);
  assert.equal((await store.listPushDevices('ana')).some((d) => d.token === token), false);

  // A broadcast does not notify, even with a key set.
  calls.length = 0;
  nextResponse = { status: 200 };
  await store.upsertPushDevice({ participant: 'ana', token, platform: 'ios', env: 'production', bundle_id: 'dev.trialog.app' });
  await notifyPushForMessage(store, messageTo(null, 13));
  assert.equal(calls.length, 0);

  // Production host when the device says so; BadDeviceToken also disables.
  nextResponse = { status: 400, reason: 'BadDeviceToken' };
  await notifyPushForMessage(store, messageTo('ana', 14));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'api.push.apple.com');
  assert.equal(calls[0].headers['apns-topic'], 'dev.trialog.app');
  assert.equal((await store.listPushDevices('ana')).some((d) => d.token === token), false);
});

test('an ES256 APNs JWT uses a raw P1363 signature and does not put an exp claim', () => {
  const token = signApnsJwt({ keyId: 'TESTKEYID1', teamId: 'TESTTEAM01', keyP8: testP8 }, 1_700_000_000);
  const [header, payload, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'TESTKEYID1' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), { iss: 'TESTTEAM01', iat: 1_700_000_000 });
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
});

test('only a message or wait addressed to a human notifies them', () => {
  const roster = [
    { name: 'ana', kind: 'human' as const, color: 0, label: 'Ana' },
    { name: 'scout', kind: 'agent' as const, color: 1 },
  ];
  assert.deepEqual(humansForMessage({ sender: 'scout', recipient: 'ana' }, roster), ['ana']);
  assert.deepEqual(humansForMessage({ sender: 'scout', recipient: null }, roster), []);
  assert.deepEqual(humansForMessage({ sender: 'ana', recipient: 'scout' }, roster), []);
  assert.deepEqual(humansForFlight({ state: 'waiting', text: 'Ana: review the PR', participant: 'scout' }, roster), ['ana']);
  assert.deepEqual(humansForFlight({ state: 'working', text: 'Ana: review the PR', participant: 'scout' }, roster), []);
  assert.deepEqual(humansForFlight({ state: 'waiting', text: 'review the PR', participant: 'scout' }, roster), []);
  const card = { column: 'now' as const, note: 'waiting on Ana', owner: 'scout' };
  assert.deepEqual(humansForCard(card, roster), ['ana']);
  assert.deepEqual(humansForCard({ column: 'later', note: '', owner: 'ana' }, roster), ['ana']);
  assert.deepEqual(humansForCard({ column: 'now', note: 'in review', owner: 'scout' }, roster), []);
  const item = { id: 'rm_x', column: 'next', position: 0, title: 'Ship', note: 'waiting on Ana', owner: null, updated_by: 'scout', updated_at: '', progress: null, status: '', progress_at: null, description: '', reviewer: null, raised_by: 'scout', attachments: [] } satisfies RoadmapItem;
  assert.ok(item);
  assert.match(pushAlertForMessage(messageTo('ana', 9), roster), /Ana: can you look at this\? \(#9\)|Scout: can you look at this\? \(#9\)/);
});

test('an unchanged flight does not notify again; a new since does', async () => {
  const store = await getStore();
  const token = 'd'.repeat(64);
  await store.upsertPushDevice({ participant: 'ana', token, platform: 'ios', env: 'sandbox', bundle_id: DEFAULT_BUNDLE_ID });
  process.env.APNS_KEY_ID = 'TESTKEYID1';
  process.env.APNS_TEAM_ID = 'TESTTEAM01';
  process.env.APNS_KEY_P8 = testP8;
  setApnsTransportForTests(transport);
  const flight = { participant: 'scout' as const, state: 'waiting' as const, text: 'Ana: review the PR', since: '2026-11-28T06:00:00.000Z', updated_at: '2026-11-28T06:00:00.000Z', last_message_at: null };
  await notifyPushForFlight(store, flight, null);
  assert.equal(calls.length, 1);
  await notifyPushForFlight(store, flight, flight);
  assert.equal(calls.length, 1, 'the same wait does not notify again');
  await notifyPushForFlight(store, { ...flight, since: '2026-11-28T06:05:00.000Z', text: 'Ana: look at the tests' }, flight);
  assert.equal(calls.length, 2);
  await store.deletePushDevice('ana', token);
});
