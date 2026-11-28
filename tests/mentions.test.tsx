// @names: coloured in messages when they name a participant, and checked in the draft before Send.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { leadingHandle, participantNamed, splitMentions } from '../app/mentions';
import { MentionColors, MessageBody } from '../app/markdown';

const NAMES = ['grok', 'claude', 'david', 'ana', 'ana-maria'];

test('a participant\'s @name is a mention in any case; unknown names, mail addresses and longer words are not', () => {
  assert.deepEqual(splitMentions('@grok @Claude what next?', NAMES), [
    { name: 'grok', typed: '@grok' }, ' ', { name: 'claude', typed: '@Claude' }, ' what next?',
  ]);
  assert.deepEqual(splitMentions('@claud, mail me@claude.org or @claudette', NAMES), ['@claud, mail me@claude.org or @claudette']);
  assert.deepEqual(splitMentions('thanks @ana-maria!', NAMES), ['thanks ', { name: 'ana-maria', typed: '@ana-maria' }, '!']);
  assert.deepEqual(splitMentions('(@david)', NAMES), ['(', { name: 'david', typed: '@david' }, ')']);
  assert.equal(participantNamed('GROK', NAMES), 'grok');
  assert.equal(participantNamed('grokk', NAMES), null);
});

test('the @name at the start of a draft: a participant, a typo with the nearest name, or nothing', () => {
  assert.deepEqual(leadingHandle('  @Claude please review', NAMES), { kind: 'known', name: 'claude' });
  assert.deepEqual(leadingHandle('@claud please review', NAMES), { kind: 'unknown', typed: 'claud', suggestion: 'claude' });
  assert.deepEqual(leadingHandle('@xyzzy hi', NAMES), { kind: 'unknown', typed: 'xyzzy', suggestion: null });
  assert.deepEqual(leadingHandle('hello @claud', NAMES), { kind: 'none' }, 'only the start addresses a message');
  assert.deepEqual(leadingHandle('', NAMES), { kind: 'none' });
});

test('in a message, mentions get the participant\'s colour; code and unknown names stay plain', () => {
  const color = (n: string) => ({ grok: '#f28b3c', claude: '#c792ea' }[n] ?? '#999');
  const html = renderToStaticMarkup(
    <MentionColors.Provider value={color}>
      <MessageBody text={'@grok and @claude, not @claud, nor `@grok` in code'} names={NAMES} />
    </MentionColors.Provider>,
  );
  assert.match(html, /<span data-mention="grok" class="font-semibold" style="color:#f28b3c">@grok<\/span>/);
  assert.match(html, /<span data-mention="claude"[^>]*style="color:#c792ea">@claude<\/span>/);
  assert.doesNotMatch(html, /data-mention="[^"]*">@claud</);
  assert.match(html, /<code>@grok<\/code>/);
  // Without names (or colours) the text is rendered exactly as before.
  assert.equal(renderToStaticMarkup(<MessageBody text="@grok hi" />), '<p>@grok hi</p>');
});
