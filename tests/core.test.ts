import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MAX_TEXT_BYTES, parseMessageInput, parseRecipient, parseSince, senderFromAuth, toMarkdown, type Message } from '../lib/core';

const env = {
  GROK_TOKEN: 'grok-token-0123456789abcdef',
  CLAUDE_TOKEN: 'claude-token-0123456789abcdef',
  DAVID_TOKEN: 'david-token-0123456789abcdef',
};

test('senderFromAuth maps each token to its sender', () => {
  assert.equal(senderFromAuth(`Bearer ${env.GROK_TOKEN}`, env), 'grok');
  assert.equal(senderFromAuth(`Bearer ${env.CLAUDE_TOKEN}`, env), 'claude');
  assert.equal(senderFromAuth(`bearer ${env.DAVID_TOKEN}`, env), 'david');
});

test('senderFromAuth rejects missing, malformed and wrong tokens', () => {
  for (const h of [undefined, null, '', 'Bearer', 'Bearer ', env.GROK_TOKEN, `Basic ${env.GROK_TOKEN}`,
    'Bearer wrong-token-0123456789abcdef', `Bearer ${env.GROK_TOKEN}x`, `Bearer ${env.GROK_TOKEN.slice(0, -1)}`,
    `Bearer ${env.GROK_TOKEN} ${env.CLAUDE_TOKEN}`]) {
    assert.equal(senderFromAuth(h, env), null, String(h));
  }
});

test('senderFromAuth ignores unset or too-short tokens, and refuses duplicates', () => {
  assert.equal(senderFromAuth('Bearer short', { GROK_TOKEN: 'short' }), null);
  assert.equal(senderFromAuth('Bearer ', { GROK_TOKEN: '' }), null);
  const dup = { GROK_TOKEN: 'same-token-0123456789', CLAUDE_TOKEN: 'same-token-0123456789' };
  assert.equal(senderFromAuth('Bearer same-token-0123456789', dup), null);
});

test('parseRecipient', () => {
  assert.equal(parseRecipient(undefined), null);
  assert.equal(parseRecipient(''), null);
  assert.equal(parseRecipient('everyone'), null);
  assert.equal(parseRecipient('@Claude'), 'claude');
  assert.equal(parseRecipient('grok'), 'grok');
  assert.equal(parseRecipient('hub'), undefined);
  assert.equal(parseRecipient('mallory'), undefined);
  assert.equal(parseRecipient(42), undefined);
});

const ok = (body: unknown) => {
  const r = parseMessageInput(body);
  assert.ok(r.ok, JSON.stringify(r));
  return r;
};
const fail = (body: unknown) => {
  const r = parseMessageInput(body);
  assert.ok(!r.ok, JSON.stringify(r));
  return r;
};

test('parseMessageInput: addressing by "to" or by @prefix', () => {
  assert.deepEqual(parseMessageInput({ text: 'hi all' }), { ok: true, text: 'hi all', recipient: null, pinned: false });
  assert.equal(ok({ text: '@grok please review' }).recipient, 'grok');
  assert.equal(ok({ text: '  @Claude: done?' }).recipient, 'claude');
  assert.equal(ok({ text: 'mail @grok later' }).recipient, null);
  assert.equal(ok({ text: '@grokbot hi' }).recipient, null);
  assert.equal(ok({ text: '@grok hi', to: 'david' }).recipient, 'david');
  assert.equal(parseMessageInput({ text: 'x', to: 'nobody' }).ok, false);
});

test('parseMessageInput: DECISION: prefix pins', () => {
  assert.equal(ok({ text: 'DECISION: ship v1' }).pinned, true);
  assert.equal(ok({ text: '@david DECISION: ship v1' }).pinned, true);
  assert.equal(ok({ text: '@david, DECISION: ship v1' }).pinned, true);
  assert.equal(ok({ text: 'no DECISION: yet' }).pinned, false);
  assert.equal(ok({ text: 'decision: lower case does not pin' }).pinned, false);
});

test('parseMessageInput: rejects bad bodies and caps size at 20 KB', () => {
  assert.equal(fail(null).status, 400);
  assert.equal(fail([]).status, 400);
  assert.equal(fail({}).status, 400);
  assert.equal(fail({ text: '   ' }).status, 400);
  assert.equal(fail({ text: 5 }).status, 400);
  assert.equal(parseMessageInput({ text: 'a'.repeat(MAX_TEXT_BYTES) }).ok, true);
  assert.equal(fail({ text: 'a'.repeat(MAX_TEXT_BYTES + 1) }).status, 413);
  assert.equal(fail({ text: 'ä'.repeat(MAX_TEXT_BYTES / 2 + 1) }).status, 413); // bytes, not chars
});

test('parseMessageInput ignores a spoofed sender in the body', () => {
  const r = parseMessageInput({ text: 'hi', sender: 'david', from: 'grok' });
  assert.equal('sender' in r, false);
  assert.equal('from' in r, false);
});

test('parseSince', () => {
  assert.equal(parseSince(null), null);
  assert.equal(parseSince(''), null);
  assert.equal(parseSince('0'), 0);
  assert.equal(parseSince('42'), 42);
  assert.equal(parseSince('-1'), undefined);
  assert.equal(parseSince('1.5'), undefined);
  assert.equal(parseSince('1; drop table'), undefined);
});

test('toMarkdown lists decisions first, then all messages', () => {
  const messages: Message[] = [
    { id: 1, sender: 'hub', recipient: null, text: 'Welcome', created_at: '2026-11-25T13:00:00Z', pinned_at: null },
    { id: 2, sender: 'grok', recipient: 'claude', text: 'DECISION: use Neon\nmore', created_at: '2026-11-25T13:05:00Z', pinned_at: '2026-11-25T13:05:00Z' },
  ];
  const md = toMarkdown(messages, new Date('2026-11-25T14:00:00Z'));
  assert.match(md, /^# Trialog transcript/);
  assert.match(md, /## Decisions\n\n- #2 \(Grok, 2026-11-25 14:05\): DECISION: use Neon\n/);
  assert.match(md, /\*\*Grok → Claude\*\* · 2026-11-25 14:05 · #2 · 📌\n\nDECISION: use Neon\nmore/);
  assert.ok(md.indexOf('## Decisions') < md.indexOf('## Messages'));
});
