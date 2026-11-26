import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MAX_TEXT_BYTES, UPLOADS_PER_HOUR, uploadsPerHour, firstLine, parseMessageInput, parseRecipient, parseSince, senderFromAuth, toMarkdown, type Message } from '../lib/core';
import { sniffImageType } from '../lib/images';

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
  assert.deepEqual(parseMessageInput({ text: 'hi all' }), { ok: true, text: 'hi all', recipient: null, pinned: false, attachments: [] });
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
    { id: 1, sender: 'hub', recipient: null, text: 'Welcome', created_at: '2026-11-25T13:00:00Z', pinned_at: null, attachments: [] },
    { id: 2, sender: 'grok', recipient: 'claude', text: 'DECISION: use Neon\nmore', created_at: '2026-11-25T13:05:00Z', pinned_at: '2026-11-25T13:05:00Z', attachments: [] },
  ];
  const md = toMarkdown(messages, new Date('2026-11-25T14:00:00Z'));
  assert.match(md, /^# Trialog transcript/);
  assert.match(md, /## Decisions\n\n- #2 \(Grok, 2026-11-25 14:05\): DECISION: use Neon\n/);
  assert.match(md, /\*\*Grok → Claude\*\* · 2026-11-25 14:05 · #2 · 📌\n\nDECISION: use Neon\nmore/);
  assert.ok(md.indexOf('## Decisions') < md.indexOf('## Messages'));
});

test('parseMessageInput: attachments are optional, at most 4, and make the text optional', () => {
  const a = 'att_0123456789abcdef01234567';
  const b = 'att_89abcdef0123456789abcdef';
  assert.deepEqual(ok({ text: 'look', attachments: [a, b] }).attachments, [a, b]);
  assert.deepEqual(ok({ text: 'no field' }).attachments, []);
  assert.deepEqual(ok({ text: 'null', attachments: null }).attachments, []);
  // With an image, the text may be empty or left out. Without one it may not.
  assert.equal(ok({ text: '', attachments: [a] }).text, '');
  assert.equal(ok({ attachments: [a] }).text, '');
  assert.equal(ok({ text: null, attachments: [a] }).text, '');
  assert.equal(fail({ text: '', attachments: [] }).status, 400);
  assert.equal(fail({ attachments: [] }).status, 400);
  assert.equal(fail({ text: 5, attachments: [a] }).status, 400);
  // Addressing and pinning read the text as before.
  assert.equal(ok({ text: '@grok DECISION: this layout', attachments: [a] }).recipient, 'grok');
  assert.equal(ok({ text: '@grok DECISION: this layout', attachments: [a] }).pinned, true);
  assert.equal(ok({ text: '', to: 'claude', attachments: [a] }).recipient, 'claude');

  assert.match(fail({ text: 'x', attachments: [a, b, a + '1', b + '1', a + '2'] }).error, /at most 4/);
  assert.match(fail({ text: 'x', attachments: [a, a] }).error, /twice/);
  for (const bad of ['att_x', [a, 7], [''], ['att_UPPERCASE0123456789'], ['att_0123/../456789ab'], [`${a} `], {}, 4]) {
    assert.equal(fail({ text: 'x', attachments: bad }).status, 400, JSON.stringify(bad));
  }
  assert.equal(fail({ text: 'a'.repeat(MAX_TEXT_BYTES + 1), attachments: [a] }).status, 413, 'the text cap still holds');
});

test('toMarkdown names each image, and an image-only message has no empty text block', () => {
  const shot = { id: 'att_0123456789abcdef01234567', content_type: 'image/png' as const, width: 1170, height: 2532, bytes: 1234 };
  const other = { ...shot, id: 'att_89abcdef0123456789abcdef', width: 40, height: 20 };
  const messages: Message[] = [
    { id: 3, sender: 'david', recipient: null, text: 'DECISION: this one', created_at: '2026-11-25T13:00:00Z', pinned_at: '2026-11-25T13:00:00Z', attachments: [shot] },
    { id: 4, sender: 'claude', recipient: 'david', text: '', created_at: '2026-11-25T13:01:00Z', pinned_at: '2026-11-25T13:02:00Z', attachments: [shot, other] },
  ];
  const md = toMarkdown(messages, new Date('2026-11-25T14:00:00Z'));
  assert.ok(md.includes('· #3 · 📌\n\nDECISION: this one\n\n[image: att_0123456789abcdef01234567, 1170×2532]\n\n---'));
  assert.ok(md.includes('· #4 · 📌\n\n[image: att_0123456789abcdef01234567, 1170×2532]  \n[image: att_89abcdef0123456789abcdef, 40×20]\n\n---'));
  // In the list of decisions, an image-only message is named by its images.
  assert.match(md, /- #4 \(Claude, 2026-11-25 14:01\): \[image: att_0123456789abcdef01234567, 1170×2532\] \[image: att_89abcdef0123456789abcdef, 40×20\]\n/);
  assert.equal(firstLine(messages[0], 8), 'DECISION');
});

test('sniffImageType reads the first bytes and nothing else', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b);
  const ascii = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));
  assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)), 'image/png');
  assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageType(ascii('RIFF\x10\x00\x00\x00WEBPVP8 ')), 'image/webp');
  for (const other of [ascii('RIFF\x10\x00\x00\x00WAVEfmt '), ascii('GIF89a'), ascii('<svg xmlns='), ascii('<!doctype html>'), ascii('%PDF-1.7'),
    bytes(0x89, 0x50, 0x4e, 0x47), bytes(0xff, 0xd8), bytes()]) {
    assert.equal(sniffImageType(other), null);
  }
  // A view into a larger buffer is read from its own start.
  const padded = Buffer.concat([Buffer.from('junk'), Buffer.from([0xff, 0xd8, 0xff, 0xdb])]);
  assert.equal(sniffImageType(padded.subarray(4)), 'image/jpeg');
});

test('uploadsPerHour reads the setting, and falls back to the default for anything it cannot use', () => {
  assert.equal(UPLOADS_PER_HOUR, 60);
  assert.equal(uploadsPerHour({}), 60);
  assert.equal(uploadsPerHour({ UPLOADS_PER_HOUR: '' }), 60);
  assert.equal(uploadsPerHour({ UPLOADS_PER_HOUR: '200' }), 200);
  assert.equal(uploadsPerHour({ UPLOADS_PER_HOUR: ' 20 ' }), 20);
  assert.equal(uploadsPerHour({ UPLOADS_PER_HOUR: '1' }), 1);
  assert.equal(uploadsPerHour({ UPLOADS_PER_HOUR: '1000' }), 1000);
  // Never "no limit": zero, negative, too large, fractions and words all mean the default.
  for (const bad of ['0', '-5', '1001', '99999', '12.5', '1e3', 'many', 'Infinity']) {
    assert.equal(uploadsPerHour({ UPLOADS_PER_HOUR: bad }), 60, bad);
  }
});
