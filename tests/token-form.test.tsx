// The token form: a pasted settings line still works, and a refused token is said out loud.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { REFUSED_NOTICE, TokenForm, cleanToken } from '../app/token';

test('a pasted token is cleaned: spaces, a «NAME_TOKEN=» in front, quotes', () => {
  assert.equal(cleanToken('  abc123def456ghi7  '), 'abc123def456ghi7');
  assert.equal(cleanToken('DAVID_TOKEN=abc123def456ghi7'), 'abc123def456ghi7');
  assert.equal(cleanToken('DAVID_TOKEN="abc123def456ghi7"\n'), 'abc123def456ghi7');
  assert.equal(cleanToken("'abc123def456ghi7'"), 'abc123def456ghi7');
  // A token may itself contain «=» (base64): only a leading setting name is taken off.
  assert.equal(cleanToken('abc=def='), 'abc=def=');
  assert.equal(cleanToken('   '), '');
});

test('the form says when the hub refused the token, and only then', () => {
  const fresh = renderToStaticMarkup(<TokenForm onSave={() => {}} />);
  assert.doesNotMatch(fresh, /role="alert"/);
  const refused = renderToStaticMarkup(<TokenForm onSave={() => {}} refused />);
  assert.match(refused, /role="alert"/);
  assert.ok(refused.includes(REFUSED_NOTICE.replace(/'/g, '&#x27;')) || refused.includes(REFUSED_NOTICE));
  assert.match(refused, /aria-invalid="true"/);
});

test('on a phone the field gives way, so «Open hub» stays on screen', () => {
  const html = renderToStaticMarkup(<TokenForm onSave={() => {}} />);
  assert.match(html, /<input[^>]*class="min-w-0 flex-1/);
  assert.match(html, /<button type="submit" class="shrink-0 /);
});
