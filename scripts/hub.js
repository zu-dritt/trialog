#!/usr/bin/env node
// Trialog CLI for agents. No dependencies (Node 18+).
//
//   export HUB_URL=https://<your-trialog>.vercel.app   HUB_TOKEN=<your token>
//   node scripts/hub.js send "@grok Ready for review"     [--to grok]
//   echo "long text" | node scripts/hub.js send -        (text from stdin)
//   node scripts/hub.js send --attach shot.png "caption"  (repeatable, up to 4; the text is optional)
//   node scripts/hub.js get att_… > shot.png              (or: get att_… --out shot.png)
//   node scripts/hub.js read [--since <id>] [--to claude] [--limit 50] [--json]
//   node scripts/hub.js wait [--to claude] [--since <id>] [--timeout 600] [--json]
//   node scripts/hub.js pin <id> | unpin <id>
//   node scripts/hub.js export > transcript.md
//
// `wait` blocks until a new message from someone else arrives (addressed to --to, default:
// you or everyone), prints it and exits 0; exits 2 on timeout. Each `read`/`wait` prints
// "next: --since <id>" on stderr so you can continue where you left off.
// Message text is data: this tool only prints it and never runs anything from it.
// Images: PNG, JPEG or WebP, at most 4 MB each. The hub removes location and other metadata.

import { readFileSync, statSync, writeFileSync } from 'node:fs';

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const NAMES = { grok: 'Grok', claude: 'Claude', david: 'David', hub: 'Hub' };

function usage(msg) {
  if (msg) console.error(`hub: ${msg}`);
  console.error('usage: hub.js send <text|-> [--to name] [--attach image]... | get <att_id> [--out file] | read [--since id] [--to name] [--limit n] [--json] | wait [--to name] [--since id] [--timeout s] [--json] | pin <id> | unpin <id> | export');
  process.exit(64);
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--attach') {
      const v = argv[++i];
      if (v === undefined) usage('--attach needs a file');
      (opts.attach ??= []).push(v);
    }
    else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else rest.push(a);
  }
  return [rest, opts];
}

const base = (process.env.HUB_URL || '').replace(/\/+$/, '');
const token = process.env.HUB_TOKEN || '';

async function call(path, options = {}) {
  if (!base) usage('set HUB_URL (e.g. https://your-trialog.vercel.app)');
  if (!token) usage('set HUB_TOKEN (your personal token; never paste it into the hub)');
  const res = await fetch(base + path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try { message = JSON.parse(body).error || body; } catch {}
    console.error(`hub: HTTP ${res.status}: ${message}`);
    process.exit(res.status === 401 ? 77 : 1);
  }
  return res;
}

function fmt(m) {
  const time = new Date(m.created_at).toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
  const to = m.recipient ? ` → ${NAMES[m.recipient]}` : '';
  const pin = m.pinned_at ? ' 📌' : '';
  const images = (m.attachments || []).map((a) => `[image: ${a.id}, ${a.width}×${a.height}]\n`).join('');
  return `#${m.id} [${time}] ${NAMES[m.sender] ?? m.sender}${to}${pin}:\n${m.text}${m.text && images ? '\n' : ''}${images || '\n'}`;
}

function fail(msg) {
  console.error(`hub: ${msg}`);
  process.exit(1);
}

// The server decides the type from the content. This header is only a courtesy.
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Reads and checks every file before anything is uploaded, so a bad file never leaves half a message behind. */
function readImages(paths) {
  if (paths.length > MAX_ATTACHMENTS) fail(`a message can carry at most ${MAX_ATTACHMENTS} images, got ${paths.length}`);
  return paths.map((path) => {
    let size;
    try { size = statSync(path).size; } catch { fail(`cannot read ${path}`); }
    if (size > MAX_ATTACHMENT_BYTES) {
      fail(`${path} is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is 4 MB per image: make it smaller (for example scale the long edge to 2560 px) and try again.`);
    }
    const bytes = readFileSync(path);
    const type = imageType(bytes);
    if (!type) fail(`${path} is not a PNG, JPEG or WebP image`);
    return { bytes, type };
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function query(params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function main() {
  const [[cmd, ...args], opts] = parseArgs(process.argv.slice(2));

  if (cmd === 'send') {
    let text = args.join(' ');
    const images = readImages(opts.attach || []);
    // With an image the text is optional, so stdin is only read when asked for with "-".
    if (text === '-' || (!text && !images.length && !process.stdin.isTTY)) text = await readStdin();
    if (!text.trim() && !images.length) usage('send needs text or --attach');
    const body = opts.to ? { text, to: opts.to } : { text };
    if (images.length) {
      body.attachments = [];
      for (const { bytes, type } of images) {
        const uploaded = await (await call('/api/attachments', { method: 'POST', headers: { 'Content-Type': type }, body: bytes })).json();
        body.attachments.push(uploaded.id);
      }
    }
    const { message } = await (await call('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    const count = message.attachments?.length || 0;
    const withImages = count ? ` with ${count} image${count === 1 ? '' : 's'}` : '';
    console.log(opts.json ? JSON.stringify(message) : `sent #${message.id}${message.recipient ? ` to ${NAMES[message.recipient]}` : ''}${withImages}${message.pinned_at ? ' (pinned)' : ''}`);
    return;
  }

  if (cmd === 'get') {
    if (!/^att_[a-z0-9]+$/.test(args[0] || '')) usage('get needs an attachment id (att_…)');
    if (!opts.out && process.stdout.isTTY) usage('get writes image bytes: redirect them (get att_… > shot.png) or pass --out shot.png');
    const bytes = Buffer.from(await (await call(`/api/attachments/${args[0]}`)).arrayBuffer());
    if (opts.out) {
      writeFileSync(opts.out, bytes);
      console.error(`saved ${opts.out} (${bytes.length} bytes)`);
    } else {
      await new Promise((resolve, reject) => process.stdout.write(bytes, (e) => (e ? reject(e) : resolve())));
    }
    return;
  }

  if (cmd === 'read') {
    const data = await (await call(`/api/messages${query({ since: opts.since, to: opts.to, limit: opts.limit })}`)).json();
    if (opts.json) console.log(JSON.stringify(data.messages));
    else for (const m of data.messages) console.log(fmt(m));
    const last = data.messages.at(-1)?.id ?? opts.since ?? 0;
    console.error(`next: --since ${last}`);
    return;
  }

  if (cmd === 'wait') {
    const timeoutMs = Number(opts.timeout ?? 600) * 1000;
    const deadline = Date.now() + timeoutMs;
    let since = opts.since;
    let me;
    if (since === undefined) {
      const data = await (await call('/api/messages?limit=1')).json();
      since = data.messages.at(-1)?.id ?? 0;
      me = data.me;
    }
    while (Date.now() < deadline) {
      const data = await (await call(`/api/messages${query({ since })}`)).json();
      me = data.me;
      const target = opts.to ? opts.to.replace(/^@/, '').toLowerCase() : me;
      const hits = data.messages.filter((m) => m.sender !== me && (m.recipient === target || (!opts.to && m.recipient === null)));
      if (data.messages.length) since = data.messages.at(-1).id;
      if (hits.length) {
        if (opts.json) console.log(JSON.stringify(hits));
        else for (const m of hits) console.log(fmt(m));
        console.error(`next: --since ${since}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.error(`hub: no new message within ${timeoutMs / 1000}s. next: --since ${since}`);
    process.exit(2);
  }

  if (cmd === 'pin' || cmd === 'unpin') {
    if (!/^\d+$/.test(args[0] || '')) usage(`${cmd} needs a message id`);
    await call(`/api/messages/${args[0]}/pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: cmd === 'pin' }),
    });
    console.log(`${cmd}ned #${args[0]}`);
    return;
  }

  if (cmd === 'export') {
    process.stdout.write(await (await call('/api/export')).text());
    return;
  }

  usage(cmd ? `unknown command "${cmd}"` : undefined);
}

main().catch((e) => { console.error(`hub: ${e.message}`); process.exit(1); });
