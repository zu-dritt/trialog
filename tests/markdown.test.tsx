// What a message may turn into on the page. Message text comes from other participants, so
// these rules are part of the guard rails: no raw HTML, no images loaded, careful links.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from '../app/markdown';

const html = (text: string) => renderToStaticMarkup(<MessageBody text={text} />);

test('an image becomes a link and nothing is loaded', () => {
  const out = html('Look: ![a chart](https://tracker.example/pixel.png?who=reader)');
  assert.ok(!out.includes('<img'), out);
  assert.match(out, /<a href="https:\/\/tracker\.example\/pixel\.png\?who=reader"[^>]*>\[image: a chart\]<\/a>/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer nofollow"/);
});

test('an image without a description, a reference-style image and a linked image', () => {
  assert.match(html('![](https://example.com/a.png)'), /<a href="https:\/\/example\.com\/a\.png"[^>]*>\[image\]<\/a>/);
  const reference = html('![logo][l]\n\n[l]: https://example.com/logo.svg');
  assert.ok(!reference.includes('<img'), reference);
  assert.match(reference, /\[image: logo\]/);
  // An image inside a link: still no <img>, the outer link is kept, and there is no link within a link.
  const linked = html('[![badge](https://example.com/b.svg)](https://example.com/page)');
  assert.ok(!linked.includes('<img'), linked);
  assert.match(linked, /<a href="https:\/\/example\.com\/page"[^>]*><span>\[image: badge\]<\/span><\/a>/);
  assert.equal(linked.match(/<a /g)?.length, 1, 'exactly one link');
  assert.ok(!linked.includes('b.svg'), 'the image address is not used at all');
});

test('an image with an unsafe address has no link at all', () => {
  for (const address of ['javascript:alert(1)', 'data:image/png;base64,iVBORw0KGgo=', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
    const out = html(`![x](${address})`);
    assert.ok(!out.includes('<img'), out);
    assert.ok(!out.includes('<a'), out);
    assert.ok(!out.includes(address.split(':')[0] + ':'), out);
    assert.match(out, /<span>\[image: x\]<\/span>/);
  }
});

test('raw HTML is shown as text, including an <img> tag', () => {
  const out = html('<img src="https://tracker.example/p.png" onerror="alert(1)"> and <script>alert(2)</script>');
  assert.ok(!out.includes('<img'), out);
  assert.ok(!out.includes('<script'), out);
  assert.match(out, /&lt;img src=/);
  assert.match(out, /&lt;script&gt;/);
});

test('links open in a new tab without a referrer, and javascript: links are dropped', () => {
  const out = html('[docs](https://example.com/docs) and [bad](javascript:alert(1)) and [worse](data:text/html,<b>x</b>)');
  assert.match(out, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer nofollow">docs<\/a>/);
  assert.ok(!out.includes('javascript:'), out);
  assert.ok(!out.includes('data:'), out);
  // A link whose address was unsafe keeps its text and is no link at all (not a link to nowhere).
  assert.match(out, /<span>bad<\/span>/);
  assert.equal(out.match(/<a /g)?.length, 1, 'only the safe link is a link');
  assert.ok(!out.includes('href=""'), out);
});

test('ordinary Markdown still works', () => {
  const out = html('**bold**, `code`, and a list:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```');
  for (const tag of ['<strong>bold</strong>', '<code>code</code>', '<li>one</li>', '<table>', '<pre>']) assert.ok(out.includes(tag), `${tag} missing in ${out}`);
});
