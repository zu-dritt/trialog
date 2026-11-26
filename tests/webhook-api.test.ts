// The POST route with the webhook configured: posting never waits for the webhook or fails because of it.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Message } from '../lib/core';
import { SCHEMA_SQL } from '../lib/store';

const TOKEN = 'david-test-token-0123456789abcdef';
type Handler = (request: Request) => Promise<Response>;
let POST: Handler;
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.DAVID_TOKEN = TOKEN;
  process.env.GROK_WEBHOOK_URL = 'https://grok-webhook.invalid/wake';
  process.env.GROK_WEBHOOK_SECRET = 'route-test-secret-0123456789';
  console.warn = () => {};
  // A webhook endpoint that is down: it never answers.
  globalThis.fetch = ((url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  ({ POST } = (await import('../app/api/messages/route')) as unknown as { POST: Handler });
});
afterAll(() => { globalThis.fetch = realFetch; });

test('POST returns 201 straight away while the webhook is pending', async () => {
  const started = Date.now();
  const res = await POST(new Request('http://hub.test/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ text: '@grok are you there?' }),
  }));
  assert.equal(res.status, 201);
  const { message } = (await res.json()) as { message: Message };
  assert.equal(message.recipient, 'grok');
  assert.ok(Date.now() - started < 1000, 'the response did not wait for the 2 s debounce or the webhook');
  assert.deepEqual(fetchCalls, [], 'nothing is sent before the debounce has passed');
});

test('schema.sql and the migration match the schema the app creates', async () => {
  const file = new URL('../schema.sql', import.meta.url);
  if (process.env.UPDATE_SCHEMA) await (await import('node:fs/promises')).writeFile(file, SCHEMA_SQL);
  assert.equal(await readFile(file, 'utf8'), SCHEMA_SQL, 'run UPDATE_SCHEMA=1 npm test to regenerate schema.sql');
  const squash = (sql: string) => sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
  // The migrations, one after the other, are the tail of the schema.
  const migration = async (name: string) => squash(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const names = ['001-webhook-state.sql', '002-attachments.sql', '003-status.sql', '004-polls.sql', '005-replies.sql', '006-attachment-scale.sql', '007-any-participants.sql', '008-reactions.sql', '009-decision-cards.sql', '010-read-markers.sql'];
  const tail = (await Promise.all(names.map(migration))).join(' ');
  assert.ok(squash(SCHEMA_SQL).endsWith(tail), `one of ${names.join(', ')} differs from the statements in lib/store.ts`);
});
