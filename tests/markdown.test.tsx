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
  assert.match(linked, /<a href="https:\/\/example\.com\/page"[^>]*><svg[^]*?<\/svg><span>\[image: badge\]<\/span><\/a>/);
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
  assert.match(out, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer nofollow" data-card="example\.com · \/docs" class="hovercard"><svg aria-hidden="true" data-globe=""[^]*?<\/svg>docs<\/a>/);
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

test('«PR 62» links the pull request when the hub knows its repository; #62 stays a message number', () => {
  const out = renderToStaticMarkup(<MessageBody text={'Review PR 62, then pull request #61 and PR#7. Not #62, not APR 5, not `PR 9`, not [PR 3](https://example.com/x).'} repo="owner/repo" />);
  assert.match(out, /href="https:\/\/github\.com\/owner\/repo\/pull\/62"[^>]*>(<svg[^]*?<\/svg>)?PR 62<\/a>/);
  assert.match(out, /href="https:\/\/github\.com\/owner\/repo\/pull\/61"[^>]*>(<svg[^]*?<\/svg>)?pull request #61<\/a>/);
  assert.match(out, /href="https:\/\/github\.com\/owner\/repo\/pull\/7"/);
  assert.ok(!out.includes('/pull/5'), 'APR 5 is a word, no reference');
  assert.ok(!out.includes('/pull/9'), 'code stays code');
  assert.ok(!out.includes('/pull/3'), 'a link keeps its own address');
  assert.match(out, /Not #62/);
  // Without a repository, nothing becomes a link.
  assert.ok(!renderToStaticMarkup(<MessageBody text="PR 62" repo={null} />).includes('<a'));
});

test('prefixesOf keeps good name=owner/repo entries and drops the rest', async () => {
  const { prefixesOf } = await import('../app/links');
  assert.deepEqual(prefixesOf('other-repo=example/other-repo, hub=example/hub'), {
    'other-repo': 'example/other-repo',
    hub: 'example/hub',
  });
  // A second entry for the same name is ignored; bad names and values are dropped.
  assert.deepEqual(
    prefixesOf('other-repo=example/other-repo, other-repo=example/ignored, =example/x, tools, bad=not-a-repo, ok=example/ok, /slash=example/x'),
    { 'other-repo': 'example/other-repo', ok: 'example/ok' },
  );
  assert.deepEqual(prefixesOf(''), {});
  assert.deepEqual(prefixesOf(undefined), {});
});

test('a known repo name in front of «PR 36» links that repository; a bare «PR 36» stays the hub\'s', async () => {
  const { splitPullRequests, repoForPrefix, prefixesOf } = await import('../app/links');
  const prefixes = prefixesOf('other-repo=example/other-repo,hub=example/hub');
  assert.deepEqual(splitPullRequests('see other-repo PR 36, then PR 95 and hub PR 7', prefixes), [
    'see ',
    { n: 36, typed: 'other-repo PR 36', prefix: 'other-repo' },
    ', then ',
    { n: 95, typed: 'PR 95', prefix: null },
    ' and ',
    { n: 7, typed: 'hub PR 7', prefix: 'hub' },
  ]);
  assert.equal(repoForPrefix('other-repo', 'example/hub', prefixes), 'example/other-repo');
  assert.equal(repoForPrefix(null, 'example/hub', prefixes), 'example/hub');
  assert.equal(repoForPrefix('unknown', 'example/hub', prefixes), null);

  const out = renderToStaticMarkup(<MessageBody text="Please look at other-repo PR 36, then PR 95 and hub PR 7." repo="example/hub" prefixes={prefixes} />);
  assert.match(out, /href="https:\/\/github\.com\/example\/other-repo\/pull\/36"[^>]*>(<svg[^]*?<\/svg>)?other-repo PR 36<\/a>/);
  assert.match(out, /href="https:\/\/github\.com\/example\/hub\/pull\/95"[^>]*>(<svg[^]*?<\/svg>)?PR 95<\/a>/);
  assert.match(out, /href="https:\/\/github\.com\/example\/hub\/pull\/7"[^>]*>(<svg[^]*?<\/svg>)?hub PR 7<\/a>/);
  // Prefixed names still link when the hub has no default repository; a bare «PR 95» does not.
  const noDefault = renderToStaticMarkup(<MessageBody text="other-repo PR 36 and PR 95" repo={null} prefixes={prefixes} />);
  assert.match(noDefault, /href="https:\/\/github\.com\/example\/other-repo\/pull\/36"/);
  assert.ok(!noDefault.includes('/pull/95'), 'a bare PR stays plain text without TRIALOG_REPO');
  // An unknown prefix is not swallowed: «apps PR 36» still uses the hub's repository for «PR 36».
  const unknown = renderToStaticMarkup(<MessageBody text="apps PR 36" repo="example/hub" prefixes={prefixes} />);
  assert.match(unknown, /apps <a[^>]*href="https:\/\/github\.com\/example\/hub\/pull\/36"[^>]*>(<svg[^]*?<\/svg>)?PR 36<\/a>/);
});

test('a bare address to a pull request or issue on GitHub reads short, others as written; both carry the globe', () => {
  const out = html('https://github.com/zu-dritt/trialog/pull/62 and https://github.com/zu-dritt/trialog/issues/5 and https://example.com/a');
  assert.match(out, /href="https:\/\/github\.com\/zu-dritt\/trialog\/pull\/62"[^>]*data-card="github\.com · zu-dritt\/trialog · pull request 62" class="hovercard"><svg[^]*?<\/svg>PR 62<\/a>/);
  assert.match(out, /<svg[^]*?<\/svg>issue 5<\/a>/);
  assert.match(out, /<svg[^]*?<\/svg>https:\/\/example\.com\/a<\/a>/);
  assert.equal(out.match(/data-globe/g)?.length, 3);
});

test('repoOf takes only owner/name', async () => {
  const { repoOf } = await import('../app/links');
  assert.equal(repoOf(' zu-dritt/trialog '), 'zu-dritt/trialog');
  for (const v of [undefined, '', 'trialog', 'a/b/c', 'https://github.com/a/b', 'a/..', 'a b/c']) assert.equal(repoOf(v), null, String(v));
});

test('the hovercard says the site and the rest of the address, and only links that leave the hub get one', async () => {
  const { cardText } = await import('../app/links');
  assert.equal(cardText('https://github.com/zu-dritt/trialog/pull/62'), 'github.com · zu-dritt/trialog · pull request 62');
  assert.equal(cardText('https://github.com/zu-dritt/trialog/issues/5'), 'github.com · zu-dritt/trialog · issue 5');
  assert.equal(cardText('https://github.com/zu-dritt/trialog'), 'github.com · zu-dritt/trialog');
  assert.equal(cardText('https://www.example.com/'), 'example.com');
  assert.equal(cardText('https://trialog-demo.vercel.app/?x=1'), 'trialog-demo.vercel.app · ?x=1');
  assert.match(cardText(`https://example.com/${'a'.repeat(80)}`), /…$/);
  const out = html('[demo hub](https://trialog-demo.vercel.app) and [here](#m-5)');
  assert.match(out, /data-card="trialog-demo\.vercel\.app" class="hovercard"/);
  assert.equal(out.match(/data-card=/g)?.length, 1, 'a link within the page has no card');
  assert.ok(!out.includes('title="https'), 'no native tooltip on top of the card');
});
