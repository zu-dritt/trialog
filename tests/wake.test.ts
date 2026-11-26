// The wake-up rule, the payload, target checks, and that errors never repeat a secret.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseParticipants } from '../lib/participants';
import {
  ENV_WAKE_PARTICIPANT, messagePreview, parseWakeTarget, publicDeliveryError, wakeupPayload, webhookConfig, whoToWake,
} from '../lib/webhook';

const ROSTER = parseParticipants('ana:human,scout:agent,quill:agent');

test('a message from the human wakes every agent, whoever it is addressed to', () => {
  assert.deepEqual(whoToWake({ sender: 'ana', recipient: 'scout' }, ROSTER), ['scout', 'quill']);
  assert.deepEqual(whoToWake({ sender: 'ana', recipient: 'quill' }, ROSTER), ['scout', 'quill']);
  assert.deepEqual(whoToWake({ sender: 'ana', recipient: null }, ROSTER), ['scout', 'quill']);
  assert.deepEqual(whoToWake({ sender: 'ana', recipient: 'ana' }, ROSTER), ['scout', 'quill']);
});

test('a message from an agent wakes only the agents it addresses, never the sender', () => {
  assert.deepEqual(whoToWake({ sender: 'scout', recipient: 'quill' }, ROSTER), ['quill']);
  assert.deepEqual(whoToWake({ sender: 'quill', recipient: 'scout' }, ROSTER), ['scout']);
  assert.deepEqual(whoToWake({ sender: 'scout', recipient: null }, ROSTER), ['quill'], 'to everyone: the other agents');
  assert.deepEqual(whoToWake({ sender: 'scout', recipient: 'ana' }, ROSTER), [], 'to the human: no agent');
  assert.deepEqual(whoToWake({ sender: 'scout', recipient: 'scout' }, ROSTER), [], 'never the sender');
});

test('the hub, and a sender who is not on the roster, wake no one', () => {
  assert.deepEqual(whoToWake({ sender: 'hub', recipient: null }, ROSTER), []);
  assert.deepEqual(whoToWake({ sender: 'hub', recipient: 'scout' }, ROSTER), []);
  assert.deepEqual(whoToWake({ sender: 'nobody', recipient: null }, ROSTER), []);
});

test('the preview is a short single line, cut with an ellipsis when it is long', () => {
  assert.equal(messagePreview('  Hello\n\n  world  '), 'Hello world');
  assert.equal(messagePreview('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(messagePreview('x'.repeat(201)), `${'x'.repeat(199)}…`);
  assert.equal(messagePreview('').length, 0);
});

test('the payload names the message, a short preview, and keeps first_id/last_id/count for older receivers', () => {
  const payload = wakeupPayload({ id: 41, sender: 'ana', recipient: 'scout', text: 'Line one.\nLine two.' }, ['ana', 'scout', 'quill'], 1795620000);
  assert.deepEqual(payload, {
    id: 41,
    sender: 'ana',
    recipients: ['scout'],
    preview: 'Line one. Line two.',
    first_id: 41,
    last_id: 41,
    count: 1,
    sent_at: 1795620000,
  });
  const all = wakeupPayload({ id: 7, sender: 'scout', recipient: null, text: 'hi' }, ['ana', 'scout', 'quill'], 10);
  assert.deepEqual(all.recipients, ['ana', 'scout', 'quill']);
});

test('a wake-up target must be https, with a secret, and the error never repeats the secret', () => {
  const secret = 'PASTED-SECRET-0123456789';
  const ok = parseWakeTarget({ url: 'https://scout.example/wake', secret });
  assert.deepEqual(ok, { ok: true, target: { url: 'https://scout.example/wake', secret } });

  const cases: [{ url?: unknown; secret?: unknown }, RegExp][] = [
    [{}, /https URL is required/],
    [{ url: 'https://scout.example/wake' }, /secret of at least 16/],
    [{ url: 'http://scout.example/wake', secret }, /must be https/],
    [{ url: 'not a url', secret }, /not a valid URL/],
    [{ url: 'https://scout.example/wake', secret: 'short' }, /between 16 and 256/],
    [{ url: 'https://user:pass@scout.example/wake', secret }, /must not include a username or a password/],
  ];
  for (const [input, expected] of cases) {
    const result = parseWakeTarget(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) {
      assert.match(result.error, expected);
      assert.ok(!result.error.includes(secret), result.error);
    }
  }
});

test('public delivery errors strip the secret and the URL', () => {
  const target = { url: 'https://scout.example/wake?token=abc', secret: 'delivery-secret-01234567' };
  const raw = `fetch failed for ${target.url} with ${target.secret}`;
  const safe = publicDeliveryError(raw, [target]);
  assert.ok(!safe.includes(target.secret));
  assert.ok(!safe.includes('scout.example'));
  assert.match(safe, /\[url\]/);
  assert.match(safe, /\[secret\]/);
});

test('the env fallback is still only for the participant named grok, when that name is on the roster', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const url = 'https://grok.example/wake';
    const secret = 'a-long-enough-secret-0123456789';
    assert.equal(ENV_WAKE_PARTICIPANT, 'grok');
    assert.deepEqual(webhookConfig({ GROK_WEBHOOK_URL: url, GROK_WEBHOOK_SECRET: secret }), { url, secret });
    assert.equal(webhookConfig({ GROK_WEBHOOK_URL: url, GROK_WEBHOOK_SECRET: secret, PARTICIPANTS: 'ana:human,scout:agent' }), null);
  } finally {
    console.warn = warn;
  }
});
