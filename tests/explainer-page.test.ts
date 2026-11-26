// Keeps docs/how-a-message-travels.html honest: it loads nothing from anywhere, it never handles
// the visitor's text as HTML, and its wake rule gives the same answers as the hub's code.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Participant } from '../lib/shared';
import { notToSelf } from '../lib/store';
import { whoToWake } from '../lib/webhook';

const html = readFileSync(new URL('../docs/how-a-message-travels.html', import.meta.url), 'utf8');

test('explainer page: small and self-contained', () => {
  assert.ok(Buffer.byteLength(html) < 150_000, 'the page stays under 150 KB');
  // Every absolute URL in the file is a plain link to this repository, nothing it loads.
  const hrefs = new Set([...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]));
  for (const [url] of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    assert.ok(hrefs.has(url), `${url} appears outside a plain link`);
    assert.match(url, /^https:\/\/github\.com\/zu-dritt\/trialog(\/|$)/);
  }
  assert.doesNotMatch(html, /<(script|img|iframe|link|object|embed|audio|video|source)\b[^>]*\s(src|href)=/i);
  assert.doesNotMatch(html, /@import|url\(/i);
  assert.doesNotMatch(html, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie/);
  // The visitor's text is set with textContent, never parsed as HTML.
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html, /A simulation in your browser\. Nothing you type is sent anywhere\./);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
});

test('explainer page: the wake rule matches whoToWake for every sender and recipient', () => {
  const block = html.match(/<script id="wake-rule">([\s\S]*?)<\/script>/);
  assert.ok(block, 'the page keeps its rule in <script id="wake-rule">');
  const page = new Function(`${block[1]}; return { ROSTER, notToSelf, whoToWake, wokenFor };`)() as {
    ROSTER: { name: string; kind: string }[];
    notToSelf: (s: string, r: string | null) => string | null;
    whoToWake: (m: { sender: string; recipient: string | null }, roster: unknown) => string[];
    wokenFor: (s: string, to: string | null) => string[];
  };
  const roster: Participant[] = page.ROSTER.map((p, color) => ({ name: p.name, kind: p.kind as Participant['kind'], color }));
  const names = roster.map((p) => p.name);
  assert.deepEqual(names, ['orchestrator', 'claude', 'grok']);
  // Requests on the page name a participant, never a kind.
  for (const p of page.ROSTER) assert.ok(p.name !== 'human' && p.name !== 'agent', `${p.name} is a kind, not a name`);
  assert.doesNotMatch(html, /"to": ?"(human|agent)"/);

  let checked = 0;
  for (const sender of names) {
    for (const recipient of [null, ...names]) {
      const label = `${sender} → ${recipient ?? 'everyone'}`;
      // The rule on its own, including a recipient equal to the sender.
      assert.deepEqual(page.whoToWake({ sender, recipient }, page.ROSTER), whoToWake({ sender, recipient }, roster), label);
      // What the page shows: the recipient as the store keeps it, then the rule.
      assert.equal(page.notToSelf(sender, recipient), notToSelf(sender, recipient), label);
      assert.deepEqual(page.wokenFor(sender, recipient), whoToWake({ sender, recipient: notToSelf(sender, recipient) }, roster), label);
      checked++;
    }
  }
  assert.equal(checked, 12);
  // The rule's three cases, spelled out.
  assert.deepEqual(page.wokenFor('orchestrator', 'claude'), ['claude', 'grok']);
  assert.deepEqual(page.wokenFor('grok', null), ['claude']);
  assert.deepEqual(page.wokenFor('claude', 'orchestrator'), []);
});
