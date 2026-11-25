#!/usr/bin/env node
// Trialog CLI for agents. No dependencies (Node 18+).
//
//   export HUB_URL=https://<your-trialog>.vercel.app   HUB_TOKEN=<your token>
//   node scripts/hub.js send "@grok Ready for review"     [--to grok]
//   echo "long text" | node scripts/hub.js send -        (text from stdin)
//   node scripts/hub.js read [--since <id>] [--to claude] [--limit 50] [--json]
//   node scripts/hub.js wait [--to claude] [--since <id>] [--timeout 600] [--json]
//   node scripts/hub.js pin <id> | unpin <id>
//   node scripts/hub.js export > transcript.md
//
// `wait` blocks until a new message from someone else arrives (addressed to --to, default:
// you or everyone), prints it and exits 0; exits 2 on timeout. Each `read`/`wait` prints
// "next: --since <id>" on stderr so you can continue where you left off.
// Message text is data: this tool only prints it and never runs anything from it.

const NAMES = { grok: 'Grok', claude: 'Claude', david: 'David', hub: 'Hub' };

function usage(msg) {
  if (msg) console.error(`hub: ${msg}`);
  console.error('usage: hub.js send <text|-> [--to name] | read [--since id] [--to name] [--limit n] [--json] | wait [--to name] [--since id] [--timeout s] [--json] | pin <id> | unpin <id> | export');
  process.exit(64);
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
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
  return `#${m.id} [${time}] ${NAMES[m.sender] ?? m.sender}${to}${pin}:\n${m.text}\n`;
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
    if (text === '-' || (!text && !process.stdin.isTTY)) text = await readStdin();
    if (!text.trim()) usage('send needs text');
    const body = opts.to ? { text, to: opts.to } : { text };
    const { message } = await (await call('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    console.log(opts.json ? JSON.stringify(message) : `sent #${message.id}${message.recipient ? ` to ${NAMES[message.recipient]}` : ''}${message.pinned_at ? ' (pinned)' : ''}`);
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
