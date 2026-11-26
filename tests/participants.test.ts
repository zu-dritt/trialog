// The PARTICIPANTS setting: how it is read, how tokens map to it, and how addressing follows it.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseMessageInput, parseRecipient, senderFromAuth, toMarkdown, welcomeText, type Message } from '../lib/core';
import {
  ConfigError, DEFAULT_PARTICIPANTS, MAX_PARTICIPANTS, holdsListedToken, loadRoster, parseParticipants, tokenEnvName,
} from '../lib/participants';
import { NEUTRAL_COLOR, PARTICIPANT_COLORS, colorOf, displayName } from '../lib/shared';
import { webhookConfig } from '../lib/webhook';

// Four made-up participants: two people and two agents. Two of the names contain "-".
const FOUR = 'ana-maria:human,ben:human,scout:agent,quill-2:agent';
const TOKENS = {
  ANA_MARIA_TOKEN: 'ana-maria-test-token-0123456789',
  BEN_TOKEN: 'ben-test-token-0123456789abcdef',
  SCOUT_TOKEN: 'scout-test-token-0123456789abcd',
  QUILL_2_TOKEN: 'quill-2-test-token-0123456789ab',
};
const ENV = { PARTICIPANTS: FOUR, ...TOKENS };
const NAMES = ['ana-maria', 'ben', 'scout', 'quill-2'];

/** The ConfigError a call throws, or a failed assertion. */
function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${String(e)}`);
    return e;
  }
  return assert.fail('expected a ConfigError, but nothing was thrown');
}

test('a well-formed setting gives the participants in order, with a colour each', () => {
  assert.deepEqual(parseParticipants(FOUR), [
    { name: 'ana-maria', kind: 'human', color: 0 },
    { name: 'ben', kind: 'human', color: 1 },
    { name: 'scout', kind: 'agent', color: 2 },
    { name: 'quill-2', kind: 'agent', color: 3 },
  ]);
  // Spaces around an entry or around the colon are fine.
  assert.deepEqual(parseParticipants(' ana : human ,  scout:agent ').map((p) => p.name), ['ana', 'scout']);
  // The smallest and the largest hub, and the longest name.
  assert.equal(parseParticipants('a:human,b:agent').length, 2);
  const twelve = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => `p${i}:agent`).join(',');
  assert.deepEqual(parseParticipants(twelve).map((p) => p.color), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(parseParticipants(`${'n'.repeat(24)}:human,b:agent`)[0].name.length, 24);
});

test('a malformed setting is refused with a message that says what is wrong', () => {
  const cases: [string, RegExp][] = [
    ['ana:human', /at least 2 participants.*found 1/],
    [Array.from({ length: 13 }, (_, i) => `p${i}:agent`).join(','), /at most 12 participants.*found 13/],
    ['ana:human,ben', /entry 2 must be name:kind/],
    ['ana:human,ben:human:extra', /entry 2 must be name:kind/],
    ['ana:human,,ben:human', /entry 2 must be name:kind/],
    ['ana:human,ben:human,', /entry 3 must be name:kind/],
    ['ana:human;ben:human', /at least 2 participants/],
    ['ana:human,ben:robot', /entry 2 \("ben"\) needs the kind human or agent/],
    ['ana:human,ben:Human', /entry 2 \("ben"\) needs the kind human or agent/],
    ['ana:human,ben:', /entry 2 \("ben"\) needs the kind human or agent/],
    ['Ana:human,ben:human', /entry 1 has a name that can't be used.*lowercase/],
    ['ana:human,2ben:human', /entry 2 has a name that can't be used/],
    ['ana:human,-ben:human', /entry 2 has a name that can't be used/],
    ['ana:human,ben_2:human', /entry 2 has a name that can't be used/],
    ['ana:human,b en:human', /entry 2 has a name that can't be used/],
    ['ana:human,bén:human', /entry 2 has a name that can't be used/],
    ['ana:human,:human', /entry 2 has a name that can't be used/],
    [`ana:human,${'n'.repeat(25)}:human`, /entry 2 has a name that can't be used.*at most 24/],
    ['ana:human,ben:human,ana:agent', /lists "ana" more than once/],
  ];
  for (const [value, expected] of cases) assert.match(configError(() => parseParticipants(value)).message, expected, value);
  for (const reserved of ['all', 'everyone', 'hub', 'system']) {
    assert.match(configError(() => parseParticipants(`ana:human,${reserved}:agent`)).message, new RegExp(`entry 2 uses the name "${reserved}", which is reserved`));
  }
});

test('the message about a malformed entry never repeats the entry', () => {
  // Someone pasted a token into the wrong setting. It must not come back in an error message.
  for (const value of ['ana:human,ben=PASTED-SECRET-0123456789', 'ana:human,PASTED-SECRET-0123456789:human', 'ana:human,ben:PASTED-SECRET-0123456789']) {
    assert.doesNotMatch(configError(() => parseParticipants(value)).message, /PASTED|SECRET|0123456789/, value);
  }
});

test('without the setting, the first three participants apply, as leniently as before', () => {
  for (const env of [{}, { PARTICIPANTS: '' }, { PARTICIPANTS: '   ' }]) {
    const roster = loadRoster(env);
    assert.equal(roster.explicit, false);
    assert.deepEqual(roster.participants, [
      { name: 'grok', kind: 'agent', color: 0 },
      { name: 'claude', kind: 'agent', color: 1 },
      { name: 'david', kind: 'human', color: 2 },
    ]);
    assert.deepEqual(roster.names, ['grok', 'claude', 'david']);
  }
  assert.equal(DEFAULT_PARTICIPANTS, 'grok:agent,claude:agent,david:human');
  // No token at all, one token, a short token: none of it is an error. A missing token just never matches.
  assert.equal(senderFromAuth('Bearer whatever-0123456789abcdef', {}), null);
  const one = { CLAUDE_TOKEN: 'claude-only-token-0123456789' };
  assert.equal(senderFromAuth(`Bearer ${one.CLAUDE_TOKEN}`, one), 'claude');
  assert.equal(senderFromAuth('Bearer short', { ...one, GROK_TOKEN: 'short' }), null);
  // Tokens of names that aren't participants are not tokens.
  assert.equal(senderFromAuth(`Bearer ${TOKENS.BEN_TOKEN}`, { ...one, ...TOKENS }), null);
});

test('a token lives in <NAME>_TOKEN: upper case, "-" written as "_"', () => {
  assert.equal(tokenEnvName('grok'), 'GROK_TOKEN');
  assert.equal(tokenEnvName('ana-maria'), 'ANA_MARIA_TOKEN');
  assert.equal(tokenEnvName('quill-2'), 'QUILL_2_TOKEN');
});

test('with four participants, each token maps to its participant', () => {
  assert.deepEqual(loadRoster(ENV).names, NAMES);
  assert.equal(loadRoster(ENV).explicit, true);
  assert.equal(senderFromAuth(`Bearer ${TOKENS.ANA_MARIA_TOKEN}`, ENV), 'ana-maria');
  assert.equal(senderFromAuth(`Bearer ${TOKENS.BEN_TOKEN}`, ENV), 'ben');
  assert.equal(senderFromAuth(`bearer ${TOKENS.SCOUT_TOKEN}`, ENV), 'scout');
  assert.equal(senderFromAuth(`Bearer ${TOKENS.QUILL_2_TOKEN}`, ENV), 'quill-2');
  for (const h of [undefined, null, '', 'Bearer', TOKENS.BEN_TOKEN, `Basic ${TOKENS.BEN_TOKEN}`, `Bearer ${TOKENS.BEN_TOKEN}x`, `Bearer ${TOKENS.BEN_TOKEN.slice(0, -1)}`]) {
    assert.equal(senderFromAuth(h, ENV), null, String(h));
  }
  // The old names mean nothing here, even if their variables are still set.
  const leftover = { ...ENV, GROK_TOKEN: 'grok-leftover-token-0123456789' };
  assert.equal(senderFromAuth(`Bearer ${leftover.GROK_TOKEN}`, leftover), null);
});

test('with the setting, a participant without a usable token is a configuration error', () => {
  const { SCOUT_TOKEN: _scout, ...noScout } = ENV;
  assert.match(configError(() => loadRoster(noScout)).message, /PARTICIPANTS lists scout, but SCOUT_TOKEN is not set or shorter than 16 characters/);
  assert.match(configError(() => loadRoster({ ...ENV, SCOUT_TOKEN: '' })).message, /SCOUT_TOKEN is not set/);
  // Too short: the message names the variable, never its value.
  const short = configError(() => loadRoster({ ...ENV, QUILL_2_TOKEN: 'tooshort-secret' })).message;
  assert.match(short, /PARTICIPANTS lists quill-2, but QUILL_2_TOKEN is not set or shorter than 16 characters/);
  assert.doesNotMatch(short, /tooshort-secret/);
  // Several at once are reported together.
  assert.match(configError(() => loadRoster({ PARTICIPANTS: FOUR, BEN_TOKEN: TOKENS.BEN_TOKEN })).message,
    /lists ana-maria, scout and quill-2, but ANA_MARIA_TOKEN, SCOUT_TOKEN and QUILL_2_TOKEN are not set/);
  // It is reported on every request, with or without a token, so nobody is let in on a half-working setup.
  assert.throws(() => senderFromAuth(`Bearer ${TOKENS.BEN_TOKEN}`, noScout), ConfigError);
  assert.throws(() => senderFromAuth(undefined, noScout), ConfigError);
  // The default three, written out, follow the strict rule too.
  assert.match(configError(() => loadRoster({ PARTICIPANTS: DEFAULT_PARTICIPANTS, GROK_TOKEN: 'grok-token-0123456789abcdef' })).message, /CLAUDE_TOKEN and DAVID_TOKEN are not set/);
});

test('two participants with the same token: refused, and the token is not shown', () => {
  const same = 'shared-secret-token-0123456789';
  const message = configError(() => loadRoster({ ...ENV, BEN_TOKEN: same, SCOUT_TOKEN: same })).message;
  assert.match(message, /BEN_TOKEN and SCOUT_TOKEN hold the same token/);
  assert.doesNotMatch(message, /shared-secret/);
  // Without the setting it stays as it was: the two who share a token are refused, the third is not.
  const lenient = { GROK_TOKEN: same, CLAUDE_TOKEN: same, DAVID_TOKEN: 'david-token-0123456789abcdef' };
  assert.equal(senderFromAuth(`Bearer ${same}`, lenient), null);
  assert.equal(senderFromAuth(`Bearer ${lenient.DAVID_TOKEN}`, lenient), 'david');
});

test('who is told what is wrong with a broken setting: only the holder of a listed participant\'s token', () => {
  const bearer = (token: string) => `Bearer ${token}`;
  // The setting is fine: every participant's token counts, and nothing else does.
  assert.equal(holdsListedToken(bearer(TOKENS.BEN_TOKEN), ENV), true);
  assert.equal(holdsListedToken(bearer(TOKENS.QUILL_2_TOKEN), ENV), true);
  for (const header of [undefined, null, '', 'Bearer', TOKENS.BEN_TOKEN, `Basic ${TOKENS.BEN_TOKEN}`, bearer(`${TOKENS.BEN_TOKEN}x`), bearer('not-a-real-token-0123456789')]) {
    assert.equal(holdsListedToken(header, ENV), false, String(header));
  }
  // A token for a name that is not on the list counts for nothing, even though its variable is set.
  const leftover = { ...ENV, GROK_TOKEN: 'grok-leftover-token-0123456789' };
  assert.equal(holdsListedToken(bearer(leftover.GROK_TOKEN), leftover), false);
  // The setting is broken, but the names in it can still be read: their tokens still count.
  const badKind = { ...ENV, PARTICIPANTS: 'ana-maria:human,ben:robot,scout:agent' };
  assert.throws(() => loadRoster(badKind), ConfigError);
  assert.equal(holdsListedToken(bearer(TOKENS.BEN_TOKEN), badKind), true);
  assert.equal(holdsListedToken(bearer(TOKENS.QUILL_2_TOKEN), badKind), false, 'quill-2 is not on this list');
  const { SCOUT_TOKEN: _scout, ...noScout } = ENV;
  assert.equal(holdsListedToken(bearer(TOKENS.BEN_TOKEN), noScout), true);
  assert.equal(holdsListedToken(bearer(TOKENS.SCOUT_TOKEN), noScout), false, 'the missing token is nobody\'s');
  // Two share a token: whoever holds it is one of them.
  assert.equal(holdsListedToken(bearer(TOKENS.BEN_TOKEN), { ...ENV, SCOUT_TOKEN: TOKENS.BEN_TOKEN }), true);
  // A short token never counts, and neither does a name that is not well-formed or is reserved.
  assert.equal(holdsListedToken('Bearer short', { PARTICIPANTS: 'ana:human,ben:human', ANA_TOKEN: 'short' }), false);
  const odd = { PARTICIPANTS: 'Ana:human,all:agent,hub:agent', ANA_TOKEN: 'ana-odd-token-0123456789abcdef', ALL_TOKEN: 'all-odd-token-0123456789abcdef', HUB_TOKEN: 'hub-odd-token-0123456789abcdef' };
  for (const token of [odd.ANA_TOKEN, odd.ALL_TOKEN, odd.HUB_TOKEN]) assert.equal(holdsListedToken(bearer(token), odd), false);
  // Without the setting, the default three.
  const three = { CLAUDE_TOKEN: 'claude-only-token-0123456789' };
  assert.equal(holdsListedToken(bearer(three.CLAUDE_TOKEN), three), true);
  assert.equal(holdsListedToken(bearer(TOKENS.BEN_TOKEN), { ...three, ...TOKENS }), false);
  // Whatever the setting holds, this never throws.
  for (const setting of [',,,', ':', 'a:b:c:d', '🙂:human', ' ', 'x'.repeat(5000)]) assert.doesNotThrow(() => holdsListedToken(bearer(TOKENS.BEN_TOKEN), { ...ENV, PARTICIPANTS: setting }));
});

test('recipients are the configured names', () => {
  assert.equal(parseRecipient('@Quill-2', NAMES), 'quill-2');
  assert.equal(parseRecipient('ana-maria', NAMES), 'ana-maria');
  assert.equal(parseRecipient(' BEN ', NAMES), 'ben');
  for (const everyone of [undefined, null, '', 'all', 'everyone', '@all']) assert.equal(parseRecipient(everyone, NAMES), null);
  // The first three names are nobody here, and neither is a near miss.
  for (const unknown of ['grok', 'claude', 'david', 'ana', 'quill', 'hub', 'system', 42]) assert.equal(parseRecipient(unknown, NAMES), undefined, String(unknown));
});

test('"@name" at the start of a message follows the configured names', () => {
  const to = (text: string, names = NAMES) => {
    const r = parseMessageInput({ text }, names);
    assert.ok(r.ok);
    return r.recipient;
  };
  assert.equal(to('@quill-2 please review'), 'quill-2');
  assert.equal(to('  @Ana-Maria: done?'), 'ana-maria');
  assert.equal(to('@ben, hello'), 'ben');
  assert.equal(to('mail @ben later'), null);
  assert.equal(to('@benjamin hi'), null, 'a longer word is not the name');
  assert.equal(to('@ben_2 hi'), null);
  assert.equal(to('@grok hi'), null, 'not a participant here');
  assert.equal(to('@quill-22 hi'), null);
  // When one name starts another, the longer one wins.
  const both = ['ana', 'ana-maria', 'ben'];
  assert.equal(to('@ana-maria hi', both), 'ana-maria');
  assert.equal(to('@ana hi', both), 'ana');
  assert.equal(to('@ana: hi', both), 'ana');
  // "to" wins over the prefix, and must be a participant.
  const explicit = parseMessageInput({ text: '@ben hi', to: 'scout' }, NAMES);
  assert.ok(explicit.ok && explicit.recipient === 'scout');
  const unknown = parseMessageInput({ text: 'hi', to: 'grok' }, NAMES);
  assert.ok(!unknown.ok);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.error, '"to" must be one of ana-maria, ben, scout, quill-2 (or left out for everyone).');
});

test('DECISION: after a configured "@name" pins', () => {
  const pinned = (text: string) => {
    const r = parseMessageInput({ text }, NAMES);
    assert.ok(r.ok);
    return r.pinned;
  };
  assert.equal(pinned('@quill-2 DECISION: ship it'), true);
  assert.equal(pinned('@ana-maria, DECISION: ship it'), true);
  assert.equal(pinned('DECISION: ship it'), true);
  assert.equal(pinned('@grok DECISION: ship it'), false, 'not a participant here, so the message does not start with DECISION:');
});

test('the welcome message and the export name the configured participants', () => {
  const welcome = welcomeText(parseParticipants(FOUR));
  assert.match(welcome, /\*\*Welcome to Trialog\.\*\* Ana-Maria, Ben, Scout and Quill-2 share this stream\./);
  assert.match(welcome, /Start a message with `@ana-maria`, `@ben`, `@scout` or `@quill-2` to address someone\./);
  assert.doesNotMatch(welcome, /grok|claude|david/i);
  assert.match(welcomeText(parseParticipants('ana:human,scout:agent')), /Ana and Scout share this stream\..*\n\n- Start a message with `@ana` or `@scout` to/);

  const messages: Message[] = [
    { id: 1, sender: 'hub', recipient: null, text: welcome, created_at: '2026-11-25T13:00:00Z', pinned_at: null, attachments: [] },
    { id: 2, sender: 'quill-2', recipient: 'ana-maria', text: 'DECISION: use four', created_at: '2026-11-25T13:05:00Z', pinned_at: '2026-11-25T13:05:00Z', attachments: [] },
    { id: 3, sender: 'someone-who-left', recipient: null, text: 'still here', created_at: '2026-11-25T13:06:00Z', pinned_at: null, attachments: [] },
  ];
  const md = toMarkdown(messages, new Date('2026-11-25T14:00:00Z'));
  assert.match(md, /- #2 \(Quill-2, 2026-11-25 14:05\): DECISION: use four\n/);
  assert.match(md, /\*\*Quill-2 → Ana-Maria\*\* · 2026-11-25 14:05 · #2 · 📌/);
  assert.match(md, /\*\*Someone-Who-Left\*\* · 2026-11-25 14:06 · #3\n\nstill here/);
});

test('names are shown with capitals, and coloured in the order of the setting', () => {
  assert.equal(displayName('grok'), 'Grok');
  assert.equal(displayName('ana-maria'), 'Ana-Maria');
  assert.equal(displayName('quill-2'), 'Quill-2');
  assert.equal(displayName('hub'), 'Hub');
  const four = parseParticipants(FOUR);
  assert.equal(colorOf('ana-maria', four), PARTICIPANT_COLORS[0]);
  assert.equal(colorOf('quill-2', four), PARTICIPANT_COLORS[3]);
  // The hub's welcome, someone who is no longer a participant, and the time before the list has loaded.
  assert.equal(colorOf('hub', four), NEUTRAL_COLOR);
  assert.equal(colorOf('grok', four), NEUTRAL_COLOR);
  assert.equal(colorOf('ben', []), NEUTRAL_COLOR);
});

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the palette: twelve different colours that read on the page, the first three unchanged', async () => {
  assert.equal(PARTICIPANT_COLORS.length, MAX_PARTICIPANTS);
  assert.equal(new Set(PARTICIPANT_COLORS).size, 12);
  // What Grok, Claude and the human had before colours were handed out by position.
  assert.deepEqual(PARTICIPANT_COLORS.slice(0, 3), ['#f0883e', '#c792ea', '#4fb3ff']);
  // Read from the stylesheet, so the check follows the page if its background changes.
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const theme = (name: string) => (new RegExp(`--color-${name}: (#[0-9a-f]{6});`).exec(css) ?? [])[1] ?? assert.fail(`--color-${name} not found`);
  for (const colour of [...PARTICIPANT_COLORS, NEUTRAL_COLOR]) {
    assert.match(colour, /^#[0-9a-f]{6}$/);
    // As a name on the page and on a hovered message (4.5 is the WCAG AA mark for text)…
    assert.ok(contrast(colour, theme('bg')) >= 4.5, `${colour} on the background`);
    assert.ok(contrast(colour, theme('panel')) >= 4.5, `${colour} on a panel`);
  }
  // …and no two so close that they would be taken for the same participant (distance in CIELAB,
  // where about 2 is the smallest difference an eye can see; the closest pair here is about 29).
  const lab = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883].map(f);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  for (const [i, a] of PARTICIPANT_COLORS.entries()) {
    for (const b of [...PARTICIPANT_COLORS.slice(i + 1), NEUTRAL_COLOR]) {
      const distance = Math.hypot(...lab(a).map((c, k) => c - lab(b)[k]));
      assert.ok(distance >= 25, `${a} and ${b} are too alike (${distance.toFixed(0)})`);
    }
  }
});

test('the page and the CLI have no participant names of their own', async () => {
  const app = new URL('../app/', import.meta.url);
  const files = (await readdir(app)).filter((f) => /\.(tsx|ts|css)$/.test(f) && f !== 'emoji-data.ts').map((f) => new URL(f, app));
  files.push(new URL('../scripts/hub.js', import.meta.url), new URL('../lib/shared.ts', import.meta.url));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // Comments may use a name in an example. Code may not: class names, labels, options, colours.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.doesNotMatch(code, /grok|claude|david/i, file.pathname);
  }
});

test('the wake-up webhook needs a participant named grok', () => {
  const webhook = { GROK_WEBHOOK_URL: 'https://wake.example/hook', GROK_WEBHOOK_SECRET: 'webhook-test-secret-0123456789' };
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    // Without the setting, and with a list that has a grok, it is on as before.
    assert.deepEqual(webhookConfig(webhook), { url: webhook.GROK_WEBHOOK_URL, secret: webhook.GROK_WEBHOOK_SECRET });
    const withGrok = { ...webhook, PARTICIPANTS: 'ana:human,grok:agent', ANA_TOKEN: 'ana-test-token-0123456789abcdef', GROK_TOKEN: 'grok-test-token-0123456789abcdef' };
    assert.deepEqual(webhookConfig(withGrok), { url: webhook.GROK_WEBHOOK_URL, secret: webhook.GROK_WEBHOOK_SECRET });
    assert.deepEqual(warnings, []);
    // With a list that has no grok there is nobody to wake: off, and the log says why.
    assert.equal(webhookConfig({ ...webhook, ...ENV }), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /GROK_WEBHOOK_URL is set, but PARTICIPANTS has no participant named "grok": wake-up webhook is off/);
    assert.doesNotMatch(warnings[0], /webhook-test-secret|wake\.example/);
    // A broken list is every request's 500, not this function's business.
    assert.equal(webhookConfig({ ...webhook, PARTICIPANTS: 'ana:human' }), null);
  } finally {
    console.warn = warn;
  }
});
