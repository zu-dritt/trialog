// The parts of scripts/hub.js that must hold before any request is sent.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from './fixtures';

const HUB = fileURLToPath(new URL('../scripts/hub.js', import.meta.url));
let dir = '';
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'trialog-cli-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** Runs the CLI against an address nothing listens on, so a request that was sent anyway shows up as a different error. */
function hub(...args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HUB, ...args], {
      env: { ...process.env, HUB_URL: 'http://127.0.0.1:9', HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr, stdout }));
    child.stdin?.end();
  });
}

test('send --attach refuses a file over 4 MB with a clear message, before uploading anything', async () => {
  const big = join(dir, 'big.png');
  await writeFile(big, Buffer.alloc(4 * 1024 * 1024 + 1));
  const ok = join(dir, 'ok.png');
  await writeFile(ok, await png());
  const { code, stderr } = await hub('send', '--attach', ok, '--attach', big, 'caption');
  assert.equal(code, 1);
  assert.match(stderr, /big\.png is 4\.0 MB\. The limit is 4 MB per image/);
  assert.doesNotMatch(stderr, /fetch failed|ECONNREFUSED/, 'no request was attempted');
});

test('send --attach refuses files that are not images, missing files and more than 4 files', async () => {
  const text = join(dir, 'notes.png');
  await writeFile(text, '<html>not an image</html>');
  assert.match((await hub('send', '--attach', text)).stderr, /notes\.png is not a PNG, JPEG or WebP image/);
  assert.match((await hub('send', '--attach', join(dir, 'missing.png'))).stderr, /cannot read .*missing\.png/);
  const ok = join(dir, 'ok2.png');
  await writeFile(ok, await png());
  const five = await hub('send', ...Array(5).fill(['--attach', ok]).flat(), 'five');
  assert.equal(five.code, 1);
  assert.match(five.stderr, /at most 4 images, got 5/);
  assert.equal((await hub('send', '--attach')).code, 64, '--attach needs a file');
});

test('get needs an attachment id', async () => {
  const { code, stderr } = await hub('get', '42');
  assert.equal(code, 64);
  assert.match(stderr, /get needs an attachment id/);
});

test('status validates arguments before sending any request', async () => {
  assert.equal((await hub('status', '--clear', 'text')).code, 64);
  assert.equal((await hub('status', '--clear', '--ttl', '60')).code, 64);
  assert.equal((await hub('status', '--ttl', '60')).code, 64);
  assert.equal((await hub('status', 'working', '--ttl', 'abc')).code, 64);
  assert.equal((await hub('status', '   ')).code, 64);
  const tooLong = await hub('status', 'a'.repeat(81));
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /at most 80 characters/);
  assert.doesNotMatch(tooLong.stderr, /fetch failed|ECONNREFUSED/);
});

test('status sends PUT, DELETE and GET with the Bearer token', async () => {
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'PUT') res.end(JSON.stringify({ status: { participant: 'grok', text: 'reviewing PR #7', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:00:00.000Z' } }));
      else if (req.method === 'DELETE') res.end(JSON.stringify({ cleared: true }));
      else res.end(JSON.stringify({ statuses: [] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [HUB, ...args], {
      env: { ...process.env, HUB_URL: `http://127.0.0.1:${port}`, HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
    child.stdin?.end();
  });
  try {
    const put = await run('status', 'reviewing PR #7', '--ttl', '600');
    assert.equal(put.code, 0);
    assert.match(put.stdout, /status set: reviewing PR #7/);
    const del = await run('status', '--clear');
    assert.equal(del.code, 0);
    assert.match(del.stdout, /status cleared/);
    const get = await run('status');
    assert.equal(get.code, 0);
    assert.match(get.stdout, /no active status/);
    assert.equal(seen.length, 3);
    assert.equal(seen[0].method, 'PUT');
    assert.deepEqual(JSON.parse(seen[0].body), { text: 'reviewing PR #7', ttlSeconds: 600 });
    assert.equal(seen[1].method, 'DELETE');
    assert.equal(seen[2].method, 'GET');
    for (const s of seen) {
      assert.equal(s.url, '/api/status');
      assert.equal(s.auth, 'Bearer cli-test-token-0123456789abcdef');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the CLI follows the names of the hub it talks to: --to, participants, and how names are shown', async () => {
  // A hub with made-up participants. The CLI has no list of names of its own.
  const message = { id: 7, sender: 'ana-maria', recipient: 'quill-2', text: 'hello', created_at: '2026-11-26T04:00:00.000Z', pinned_at: null, attachments: [] };
  const seen: { method: string; url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/participants') {
        res.end(JSON.stringify({ me: 'quill-2', participants: [{ name: 'ana-maria', kind: 'human', color: 0 }, { name: 'quill-2', kind: 'agent', color: 1 }] }));
      } else if (req.method === 'POST') {
        res.statusCode = 201;
        res.end(JSON.stringify({ message }));
      } else if (req.url?.startsWith('/api/status')) {
        res.end(JSON.stringify({ statuses: [{ participant: 'ana-maria', text: 'reading', expires_at: '2026-11-26T04:10:00.000Z', updated_at: '2026-11-26T04:00:00.000Z' }] }));
      } else {
        res.end(JSON.stringify({ me: 'quill-2', messages: [message], pinned: [] }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [HUB, ...args], {
      env: { ...process.env, HUB_URL: `http://127.0.0.1:${port}`, HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
    child.stdin?.end();
  });
  try {
    const sent = await run('send', '--to', 'quill-2', 'hello');
    assert.equal(sent.code, 0, sent.stderr);
    assert.deepEqual(JSON.parse(seen[0].body), { text: 'hello', to: 'quill-2' }, 'the name goes to the hub as given; the hub decides whether it is one');
    assert.match(sent.stdout, /^sent #7 to Quill-2/);

    const read = await run('read', '--to', 'quill-2');
    assert.equal(seen[1].url, '/api/messages?to=quill-2');
    assert.match(read.stdout, /^#7 \[\d\d:\d\d\] Ana-Maria → Quill-2:\nhello/);

    const who = await run('participants');
    assert.equal(who.code, 0, who.stderr);
    assert.equal(seen[2].url, '/api/participants');
    assert.equal(who.stdout, 'ana-maria (human)\nquill-2 (agent)  ← you\n');
    assert.deepEqual(JSON.parse((await run('participants', '--json')).stdout).participants.map((p: { name: string }) => p.name), ['ana-maria', 'quill-2']);

    assert.match((await run('status')).stdout, /^Ana-Maria: reading/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
