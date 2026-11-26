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

test('poll and vote validate arguments before sending any request', async () => {
  assert.equal((await hub('poll', 'Only a question')).code, 64);
  assert.equal((await hub('poll', 'Q', 'A')).code, 64);
  const tooLong = await hub('poll', 'a'.repeat(201), 'A', 'B');
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /at most 200 characters/);
  assert.doesNotMatch(tooLong.stderr, /fetch failed|ECONNREFUSED/);
  const longOpt = await hub('poll', 'Q', 'A', 'b'.repeat(81));
  assert.equal(longOpt.code, 1);
  assert.match(longOpt.stderr, /at most 80 characters/);
  const dup = await hub('poll', 'Q', 'A', 'A');
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /must be different/);
  assert.equal((await hub('vote')).code, 64);
  assert.equal((await hub('vote', '42', '1')).code, 64);
  assert.equal((await hub('vote', 'poll_aaaabbbbccccddddeeeeffff')).code, 64);
  assert.equal((await hub('vote', 'poll_aaaabbbbccccddddeeeeffff', '--clear', '1')).code, 64);
  assert.equal((await hub('poll', '--close')).code, 64);
});

test('poll and vote send the Bearer token to the poll API', async () => {
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      const poll = {
        id: 'poll_aaaabbbbccccddddeeeeffff',
        message_id: 9,
        creator: 'grok',
        question: 'Lunch?',
        options: [
          { index: 1, text: 'Pizza', votes: 1, voters: ['grok'] },
          { index: 2, text: 'Salad', votes: 0, voters: [] },
        ],
        closed_at: null,
        created_at: '2026-11-26T04:00:00.000Z',
      };
      if (req.method === 'POST' && req.url === '/api/polls') res.end(JSON.stringify({ message: { id: 9, sender: 'grok', text: 'Lunch?' }, poll }));
      else if (req.method === 'DELETE') res.end(JSON.stringify({ poll: { ...poll, options: poll.options.map((o) => ({ ...o, votes: 0, voters: [] })) }, withdrawn: true }));
      else if (req.url?.endsWith('/close')) res.end(JSON.stringify({ poll: { ...poll, closed_at: '2026-11-26T05:00:00.000Z' } }));
      else res.end(JSON.stringify({ poll }));
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
    const created = await run('poll', 'Lunch?', 'Pizza', 'Salad', '--to', 'claude');
    assert.equal(created.code, 0);
    assert.match(created.stdout, /poll poll_aaaabbbbccccddddeeeeffff on #9/);
    const voted = await run('vote', 'poll_aaaabbbbccccddddeeeeffff', '1');
    assert.equal(voted.code, 0);
    assert.match(voted.stdout, /voted 1: Pizza/);
    const cleared = await run('vote', 'poll_aaaabbbbccccddddeeeeffff', '--clear');
    assert.equal(cleared.code, 0);
    assert.match(cleared.stdout, /vote withdrawn/);
    const closed = await run('poll', '--close', 'poll_aaaabbbbccccddddeeeeffff');
    assert.equal(closed.code, 0);
    assert.match(closed.stdout, /poll closed: Lunch\?/);
    assert.equal(seen.length, 4);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/api/polls');
    assert.deepEqual(JSON.parse(seen[0].body), { question: 'Lunch?', options: ['Pizza', 'Salad'], to: 'claude' });
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].url, '/api/polls/poll_aaaabbbbccccddddeeeeffff/vote');
    assert.deepEqual(JSON.parse(seen[1].body), { option: 1 });
    assert.equal(seen[2].method, 'DELETE');
    assert.equal(seen[3].method, 'POST');
    assert.equal(seen[3].url, '/api/polls/poll_aaaabbbbccccddddeeeeffff/close');
    for (const s of seen) assert.equal(s.auth, 'Bearer cli-test-token-0123456789abcdef');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('read prints the poll id and option numbers so an agent can vote', async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      me: 'claude',
      messages: [{
        id: 9,
        sender: 'grok',
        recipient: null,
        text: 'Lunch?',
        created_at: '2026-11-26T04:00:00.000Z',
        pinned_at: null,
        attachments: [],
        poll: {
          id: 'poll_aaaabbbbccccddddeeeeffff',
          message_id: 9,
          creator: 'grok',
          question: 'Lunch?',
          options: [
            { index: 1, text: 'Pizza', votes: 1, voters: ['grok'] },
            { index: 2, text: 'Salad', votes: 0, voters: [] },
          ],
          closed_at: null,
          created_at: '2026-11-26T04:00:00.000Z',
        },
      }],
    }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const { code, stdout } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [HUB, 'read'], {
        env: { ...process.env, HUB_URL: `http://127.0.0.1:${port}`, HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
      }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
      child.stdin?.end();
    });
    assert.equal(code, 0);
    assert.match(stdout, /Poll poll_aaaabbbbccccddddeeeeffff: Lunch\?/);
    assert.match(stdout, /- 1\. Pizza/);
    assert.match(stdout, /- 2\. Salad/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('send --reply-to refuses something that is not a message id, before any request', async () => {
  for (const bad of ['abc', '0', '-3', '4.5', '#45']) {
    const { code, stderr } = await hub('send', '--reply-to', bad, 'an answer');
    assert.equal(code, 64, bad);
    assert.match(stderr, /--reply-to needs a message id/);
    assert.doesNotMatch(stderr, /fetch failed|ECONNREFUSED/, 'no request was attempted');
  }
});

test('send --reply-to posts reply_to, and read shows the arrow on a reply', async () => {
  const bodies: string[] = [];
  const reply = { id: 46, sender: 'claude', recipient: 'grok', text: 'Agreed.', created_at: '2026-11-26T04:00:00.000Z', pinned_at: null, attachments: [], reply_to: 45 };
  const plain = { ...reply, id: 45, sender: 'grok', recipient: null, text: 'Shall we?', reply_to: null };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') { bodies.push(Buffer.concat(chunks).toString()); res.statusCode = 201; res.end(JSON.stringify({ message: reply })); }
      else res.end(JSON.stringify({ me: 'claude', messages: [plain, reply], pinned: [] }));
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
    const sent = await run('send', '--reply-to', '45', '--to', 'grok', 'Agreed.');
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /sent #46 to Grok in reply to #45/);
    assert.deepEqual(JSON.parse(bodies[0]), { text: 'Agreed.', to: 'grok', reply_to: 45 });
    // Without the option the field is not sent at all, as before.
    await run('send', 'No reply.');
    assert.deepEqual(JSON.parse(bodies[1]), { text: 'No reply.' });

    const read = await run('read', '--since', '44');
    assert.equal(read.code, 0, read.stderr);
    const lines = read.stdout.split('\n');
    assert.ok(lines.some((l) => /^#45 \[\d\d:\d\d\] Grok:$/.test(l)), read.stdout);
    assert.ok(lines.some((l) => /^#46 \[\d\d:\d\d\] Claude → Grok ↳ #45:$/.test(l)), read.stdout);
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
    assert.equal(seen[1].url, '/api/messages?to=quill-2&markRead=1');
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

test('react and unreact send the Bearer token to the reactions API', async () => {
  const seen: { method: string; url: string; auth: string | undefined }[] = [];
  const message = {
    id: 42,
    sender: 'grok',
    recipient: null,
    text: 'Looks good',
    created_at: '2026-11-26T04:00:00.000Z',
    pinned_at: null,
    attachments: [],
    reactions: [{ emoji: '👍', by: ['claude'] }],
  };
  const server = createServer((req, res) => {
    seen.push({ method: req.method || '', url: req.url || '', auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'DELETE') {
      res.end(JSON.stringify({ message: { ...message, reactions: [] } }));
    } else {
      res.end(JSON.stringify({ message }));
    }
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
    const put = await run('react', '42', '👍');
    assert.equal(put.code, 0, put.stderr);
    assert.match(put.stdout, /reacted 👍 on #42 \(1\)/);
    const del = await run('unreact', '42', '👍');
    assert.equal(del.code, 0, del.stderr);
    assert.match(del.stdout, /removed 👍 from #42/);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, 'PUT');
    assert.equal(seen[1].method, 'DELETE');
    const encoded = encodeURIComponent('👍');
    for (const s of seen) {
      assert.equal(s.url, `/api/messages/42/reactions/${encoded}`);
      assert.equal(s.auth, 'Bearer cli-test-token-0123456789abcdef');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('read prints reactions so an agent can see who reacted', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      me: 'claude',
      messages: [{
        id: 9,
        sender: 'grok',
        recipient: null,
        text: 'Looks good',
        created_at: '2026-11-26T04:00:00.000Z',
        pinned_at: null,
        attachments: [],
        reactions: [{ emoji: '👍', by: ['david', 'claude'] }],
      }],
    }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const { code, stdout } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [HUB, 'read'], {
        env: { ...process.env, HUB_URL: `http://127.0.0.1:${port}`, HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
      }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
      child.stdin?.end();
    });
    assert.equal(code, 0);
    assert.match(stdout, /\[reactions: 👍 David, Claude\]/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('react needs a message id and an emoji', async () => {
  assert.equal((await hub('react')).code, 64);
  assert.equal((await hub('react', '42')).code, 64);
  assert.equal((await hub('unreact', 'nope', '👍')).code, 64);
});

test('react reports the count even when the server stores the catalogue form of the emoji', async () => {
  const heart = '❤️'; // catalogue form, with the variation selector
  const typed = '\u2764'; // what a client may send
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      message: {
        id: 42,
        reactions: [{ emoji: heart, by: ['claude'] }],
      },
    }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const { code, stdout } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [HUB, 'react', '42', typed], {
        env: { ...process.env, HUB_URL: `http://127.0.0.1:${port}`, HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
      }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
      child.stdin?.end();
    });
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`reacted ${heart} on #42 \\(1\\)`));
    assert.doesNotMatch(stdout, /\(0\)/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('search needs at least one word, before any request', async () => {
  for (const args of [['search'], ['search', '   '], ['search', '--json'], ['search', '--pinned'], ['search', '--decisions']]) {
    const { code, stderr } = await hub(...args);
    assert.equal(code, 64, args.join(' '));
    assert.match(stderr, /search needs at least one word/);
    assert.doesNotMatch(stderr, /fetch failed|ECONNREFUSED/, 'no request was attempted');
  }
});

test('search sends the words as q with the token, and prints the results like read', async () => {
  const seen: { url: string; auth: string | undefined }[] = [];
  const found = [
    { id: 12, sender: 'claude', recipient: 'grok', text: 'DECISION: images go into the database', created_at: '2026-11-26T04:05:00.000Z', pinned_at: '2026-11-26T04:05:00.000Z', attachments: [], reply_to: 9, poll: null },
    { id: 9, sender: 'grok', recipient: null, text: 'Which storage for the images?', created_at: '2026-11-26T04:00:00.000Z', pinned_at: null, attachments: [], reply_to: null, poll: null },
  ];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ me: 'claude', messages: (req.url ?? '').includes('zebra') ? [] : found }));
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
    const plain = await run('search', 'images 100%', '--limit', '20', '--to', 'grok', '--pinned', '--decisions');
    assert.equal(plain.code, 0);
    const url = new URL(seen[0].url, 'http://hub.test');
    assert.equal(url.pathname, '/api/messages');
    // The words arrive as typed: the percent sign is encoded for the address, not taken as a pattern.
    assert.equal(url.searchParams.get('q'), 'images 100%');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('to'), 'grok');
    assert.equal(url.searchParams.get('pinned'), '1');
    assert.equal(url.searchParams.get('decisions'), '1');
    assert.equal(seen[0].auth, 'Bearer cli-test-token-0123456789abcdef');
    // Printed like read, in the order the hub gave: newest first.
    assert.match(plain.stdout, /^#12 \[\d\d:\d\d\] Claude → Grok ↳ #9 📌:\nDECISION: images go into the database\n\n#9 \[\d\d:\d\d\] Grok:\nWhich storage for the images\?\n/);
    assert.match(plain.stderr, /^2 found, newest first$/m);

    // Several words without quotes are one query; without options nothing else is sent.
    await run('search', 'storage', 'images');
    assert.equal(new URL(seen[1].url, 'http://hub.test').search, '?q=storage+images');

    const asJson = await run('search', 'images', '--json');
    assert.deepEqual(JSON.parse(asJson.stdout), found);

    const none = await run('search', 'zebra');
    assert.equal(none.code, 0);
    assert.equal(none.stdout, '');
    assert.match(none.stderr, /^nothing found$/m);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('wait records the messages it returns as read, and --peek leaves them unmarked', async () => {
  const seen: string[] = [];
  const incoming = {
    id: 9,
    sender: 'david',
    recipient: null,
    text: 'Are you there?',
    created_at: '2026-11-26T04:00:00.000Z',
    pinned_at: null,
    attachments: [],
  };
  const watermark = { ...incoming, id: 8, sender: 'claude', text: 'earlier' };
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url ?? '', 'http://hub.test');
    if (url.searchParams.get('limit') === '1' && !url.searchParams.has('since')) {
      res.end(JSON.stringify({ me: 'claude', messages: [watermark], pinned: [] }));
      return;
    }
    res.end(JSON.stringify({ me: 'claude', messages: [incoming], pinned: [] }));
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
    const marked = await run('wait', '--since', '8', '--timeout', '5');
    assert.equal(marked.code, 0, marked.stderr);
    assert.equal(seen[0], '/api/messages?since=8&markRead=1');
    assert.match(marked.stdout, /Are you there\?/);
    assert.match(marked.stderr, /next: --since 9/);

    const peeked = await run('wait', '--since', '8', '--peek', '--timeout', '5');
    assert.equal(peeked.code, 0, peeked.stderr);
    assert.equal(seen[1], '/api/messages?since=8');
    assert.match(peeked.stdout, /Are you there\?/);

    const fromStart = await run('wait', '--timeout', '5');
    assert.equal(fromStart.code, 0, fromStart.stderr);
    assert.equal(seen[2], '/api/messages?limit=1', 'the watermark request does not mark as read');
    assert.equal(seen[3], '/api/messages?since=8&markRead=1');

    const readPeek = await run('read', '--peek', '--to', 'claude');
    assert.equal(readPeek.code, 0, readPeek.stderr);
    assert.equal(seen[4], '/api/messages?to=claude');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('read --peek cannot be combined with --up-to, and no request is sent', async () => {
  const { code, stderr } = await hub('read', '--peek', '--up-to', '9');
  assert.equal(code, 64);
  assert.match(stderr, /read --peek cannot be combined with --up-to/);
  assert.doesNotMatch(stderr, /fetch failed|ECONNREFUSED/, 'no request was attempted');
});

test('wake set and show print only the host, and wake list / clear work for a human', async () => {
  const seen: { method?: string; url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url ?? '', body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      if ((req.url ?? '').startsWith('/api/participants')) {
        res.end(JSON.stringify({
          me: 'ana-maria',
          participants: [
            { name: 'ana-maria', kind: 'human', color: 0, wake_target_host: null, wake_target_set_at: null },
            { name: 'quill-2', kind: 'agent', color: 1, wake_target_host: 'quill.example', wake_target_set_at: '2026-11-26T09:00:00.000Z' },
          ],
        }));
        return;
      }
      if (req.method === 'PUT') {
        res.end(JSON.stringify({ target: { host: 'scout.example', updated_at: '2026-11-26T09:00:00.000Z' } }));
        return;
      }
      if (req.method === 'DELETE') {
        res.end(JSON.stringify({ cleared: true }));
        return;
      }
      res.end(JSON.stringify({ target: { host: 'scout.example', updated_at: '2026-11-26T09:00:00.000Z' } }));
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
    const set = await run('wake', 'set', 'https://scout.example/hooks/secret-path', 'a-cli-secret-01234567');
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /scout\.example/);
    assert.doesNotMatch(set.stdout, /hooks\/secret-path|https:\/\/|a-cli-secret/);
    assert.equal(JSON.parse(seen[0].body).url, 'https://scout.example/hooks/secret-path');

    const show = await run('wake', 'show');
    assert.equal(show.code, 0, show.stderr);
    assert.equal(show.stdout.trim(), 'scout.example');
    assert.doesNotMatch(show.stdout, /https:\/\//);

    const list = await run('wake', 'list');
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /Quill-2: quill\.example/);
    assert.doesNotMatch(list.stdout, /https:\/\//);
    assert.equal(seen[2].url, '/api/participants');

    const cleared = await run('wake', 'clear', 'quill-2');
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(seen[3].method, 'DELETE');
    assert.equal(seen[3].url, '/api/wake/target?participant=quill-2');
    assert.match(cleared.stdout, /Quill-2/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('--room goes out with send, read, wait, search, poll, decision and export; rooms lists and creates', async () => {
  const seen: { method: string; url: string; body: string }[] = [];
  const base = { sender: 'grok', recipient: null, created_at: '2026-11-26T04:00:00.000Z', pinned_at: null, attachments: [], reply_to: null, reactions: [] };
  const inCalm = { ...base, id: 46, text: 'in calm', room: 'calm' };
  const inMain = { ...base, id: 45, text: 'in main', room: 'main' };
  const room = { id: 'calm', name: 'Calm talk', created_at: '2026-11-26T04:00:00.000Z', created_by: 'david', last_id: 46 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', body: Buffer.concat(chunks).toString() });
      const path = (req.url || '').split('?')[0];
      res.setHeader('Content-Type', 'application/json');
      if (path === '/api/export') { res.setHeader('Content-Type', 'text/markdown'); res.end('# Trialog transcript: all rooms\n'); }
      else if (path === '/api/rooms' && req.method === 'POST') { res.statusCode = 201; res.end(JSON.stringify({ room: { ...room, last_id: 0 } })); }
      else if (path === '/api/rooms') res.end(JSON.stringify({ me: 'claude', rooms: [{ ...room, id: 'main', name: 'Main', created_by: 'hub', last_id: 45 }, room] }));
      else if (path === '/api/polls') { res.statusCode = 201; res.end(JSON.stringify({ message: { ...inCalm, id: 47 }, poll: { id: 'poll_0123456789abcdef', question: 'Lunch?' } })); }
      else if (path === '/api/decisions') { res.statusCode = 201; res.end(JSON.stringify({ message: { ...inCalm, id: 48, decision: { id: 'decision_0123456789abcdef' } } })); }
      else if (req.method === 'POST') { res.statusCode = 201; res.end(JSON.stringify({ message: inCalm })); }
      else res.end(JSON.stringify({ me: 'claude', messages: [inMain, inCalm], pinned: [] }));
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
  const last = () => seen[seen.length - 1];
  try {
    const sent = await run('send', '--room', 'calm', 'in calm');
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /^sent #46 in calm$/m);
    assert.deepEqual(JSON.parse(last().body), { text: 'in calm', room: 'calm' });
    // Without the option nothing about rooms is sent, as before.
    await run('send', 'plain');
    assert.deepEqual(JSON.parse(last().body), { text: 'plain' });

    const read = await run('read', '--room', 'all', '--since', '44');
    assert.equal(last().url, '/api/messages?since=44&room=all&markRead=1');
    const lines = read.stdout.split('\n');
    assert.ok(lines.some((l) => /^#45 \[\d\d:\d\d\] Grok:$/.test(l)), 'a message in main reads as it always did');
    assert.ok(lines.some((l) => /^#46 \[\d\d:\d\d\] \[calm\] Grok:$/.test(l)), read.stdout);
    await run('read');
    assert.equal(last().url, '/api/messages?markRead=1', 'read without --room asks as before');

    await run('search', 'calm', '--room', 'calm');
    assert.equal(last().url, '/api/messages?q=calm&room=calm');
    const waited = await run('wait', '--room', 'calm', '--since', '44', '--timeout', '5');
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(last().url, '/api/messages?since=44&room=calm&markRead=1');

    await run('poll', 'Lunch?', 'Yes', 'No', '--room', 'calm');
    assert.deepEqual(JSON.parse(last().body), { question: 'Lunch?', options: ['Yes', 'No'], room: 'calm' });
    await run('decision', 'Ship it?', '--room', 'calm');
    assert.deepEqual(JSON.parse(last().body), { prompt: 'Ship it?', room: 'calm' });
    await run('decision', 'Ship it?');
    assert.deepEqual(JSON.parse(last().body), { prompt: 'Ship it?' });

    await run('wake', '--room', 'all', '--since', '44');
    assert.equal(last().url, '/api/wake?since=44&room=all');
    await run('wake', '--since', '44');
    assert.equal(last().url, '/api/wake?since=44', 'wake without --room asks as before');

    const exported = await run('export', '--room', 'all');
    assert.equal(last().url, '/api/export?room=all');
    assert.match(exported.stdout, /all rooms/);
    await run('export');
    assert.equal(last().url, '/api/export');

    const listed = await run('rooms');
    assert.deepEqual(listed.stdout.trim().split('\n'), ['main  Main  (newest #45)', 'calm  Calm talk  (newest #46)']);
    const created = await run('rooms', '--create', 'Calm talk', '--id', 'calm');
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual([last().method, last().url, JSON.parse(last().body)], ['POST', '/api/rooms', { name: 'Calm talk', id: 'calm' }]);
    assert.match(created.stdout, /^room calm created: Calm talk$/m);
    await run('rooms', '--create', 'Calm talk');
    assert.deepEqual(JSON.parse(last().body), { name: 'Calm talk' }, 'without --id the server makes the id from the name');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
