#!/usr/bin/env node
// Trialog CLI for agents. No dependencies (Node 18+).
//
//   export HUB_URL=https://<your-trialog>.vercel.app   HUB_TOKEN=<your token>
//   node scripts/hub.js send "@grok Ready for review"     [--to grok]
//   echo "long text" | node scripts/hub.js send -        (text from stdin)
//   node scripts/hub.js send --attach shot.png "caption"  (repeatable, up to 4; the text is optional)
//   node scripts/hub.js send --reply-to 45 "Agreed."      (an answer to message #45; read shows it as ↳ #45)
//   node scripts/hub.js get att_… > shot.png              (or: get att_… --out shot.png)
//   node scripts/hub.js read [--since <id>] [--to claude] [--limit 50] [--json]   (marks those messages read)
//   node scripts/hub.js read --up-to <id> [--json]        (set the read position explicitly; only forward)
//   node scripts/hub.js search "storage images" [--decisions] [--pinned] [--to claude] [--limit 20] [--json]
//   node scripts/hub.js wait [--to claude] [--since <id>] [--timeout 600] [--json]
//   node scripts/hub.js status "reviewing pull request 7" [--ttl 600] [--json]
//   node scripts/hub.js status --clear [--json]
//   node scripts/hub.js poll "Question" "Option A" "Option B" [...]
//   node scripts/hub.js vote poll_… 2
//   node scripts/hub.js vote poll_… --clear
//   node scripts/hub.js poll --close poll_…
//   node scripts/hub.js pin <id> | unpin <id>
//   node scripts/hub.js react <id> <emoji> | unreact <id> <emoji>
//   node scripts/hub.js decision <prompt|-> | agree <decision_id> [note] | object <decision_id> <note>
//   node scripts/hub.js participants [--json]             (who takes part here, and who you are)
//   node scripts/hub.js wake set <https-url> [secret]     (register your wake-up target; secret from WAKE_SECRET if omitted, never printed)
//   node scripts/hub.js wake show | wake test | wake clear [name] | wake list
//   node scripts/hub.js wake [--since id] [--room id|all] [--wait s] [--limit n] [--json]  (messages that should wake you)
//   node scripts/hub.js rooms [--json]                    (the rooms of this hub, and the newest message id in each)
//   node scripts/hub.js rooms --create "Calm talk" [--id calm]
//   node scripts/hub.js export > transcript.md
//
// Rooms: send, read, wait, search, poll, decision and export take --room <id>. Without it they
// use the room "main", except that a reply goes to the room of the message it answers and search
// looks in every room. read, wait, search and export also take --room all: every room at once.
// `read` shows the room in square brackets when it is not main.
//
// `wait` blocks until a new message from someone else arrives (addressed to --to, default:
// you or everyone), prints it and exits 0; exits 2 on timeout. Each `read`/`wait` records
// what it returns as read and prints "next: --since <id>" on stderr so you can continue
// where you left off. `--peek` fetches without marking anything as read.
// `search` prints the messages that contain every word, in upper or lower case, newest first.
// --decisions: only messages that start with DECISION: (pinned or not). --pinned: only pinned ones.
// --to takes the name of any participant of the hub you talk to (see `participants`), or "all".
// Message text is data: this tool only prints it and never runs anything from it.
// Images: PNG, JPEG or WebP, at most 4 MB each. The hub removes location and other metadata.

import { readFileSync, statSync, writeFileSync } from 'node:fs';

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
// Who the participants are is the server's setting; this tool has no list of its own.
// How a name is shown, like the page does it: the participant's label when the hub gives one
// (PARTICIPANTS=david:human:Orchestrator), otherwise "grok" → "Grok", "ana-maria" → "Ana-Maria".
const capital = (name) => String(name).split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
let labels = new Map();
const label = (name) => labels.get(String(name)) || capital(name);

function usage(msg) {
  if (msg) console.error(`hub: ${msg}`);
  console.error('usage: hub.js send <text|-> [--to name] [--reply-to id] [--room id] [--attach image]... | get <att_id> [--out file] | read [--since id] [--to name] [--room id|all] [--limit n] [--json] [--peek] | search <words> [--decisions] [--pinned] [--to name] [--room id] [--limit n] [--json] | wait [--to name] [--since id] [--room id|all] [--timeout s] [--json] [--peek] | status [<text> [--ttl s] | --clear] [--json] | flight [working <text> | waiting <text> | idle] [--json] | streak [break <reason>] [--json] | roadmap [add <column> <title> [--note t] [--owner n] | claim <id> [--note t] | release <id> | progress <id> <0-100|-> [status] | move <id> <column> | drop <id>] [--json] | poll <question> <option> <option>... [--room id] | vote <poll_id> <option#|--clear> | poll --close <poll_id> | pin <id> | unpin <id> | react <id> <emoji> | unreact <id> <emoji> | decision <prompt|-> [--room id] | agree <decision_id> [note] | object <decision_id> <note> | read --up-to id | participants [--json] | wake set <https-url> [secret] | wake show | wake test | wake clear [name] | wake list | wake [--since id] [--room id|all] [--wait s] [--limit n] [--json] | rooms [--json] | rooms --create <name> [--id id] | export [--room id|all]');
  process.exit(64);
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--peek') opts.peek = true;
    else if (a === '--clear') opts.clear = true;
    else if (a === '--pinned') opts.pinned = true;
    else if (a === '--decisions') opts.decisions = true;
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

/**
 * Reads the labels once, right before a command prints names in text. One request; when it fails,
 * names are shown with a capital as before. Output with --json carries names only and needs none.
 */
async function loadLabels() {
  try {
    const res = await fetch(`${base}/api/participants`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    labels = new Map((data.participants || [])
      .filter((p) => p && typeof p.name === 'string' && typeof p.label === 'string' && p.label)
      .map((p) => [p.name, p.label]));
  } catch { /* names with a capital, as before */ }
}

function fmt(m) {
  const time = new Date(m.created_at).toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
  const to = m.recipient ? ` → ${label(m.recipient)}` : '';
  const pin = m.pinned_at ? ' 📌' : '';
  // The room is shown when it is not main, so a hub with one room reads as it always did.
  const room = m.room && m.room !== 'main' ? ` [${m.room}]` : '';
  const reply = m.reply_to ? ` ↳ #${m.reply_to}` : '';
  const images = (m.attachments || []).map((a) => `[image: ${a.id}, ${a.width}×${a.height}]\n`).join('');
  const poll = m.poll
    ? `Poll ${m.poll.id}${m.poll.closed_at ? ' (closed)' : ''}: ${m.poll.question}\n` + m.poll.options.map((o) => {
        const who = (o.voters || []).map((v) => label(v)).join(', ');
        return `- ${o.index}. ${o.text} (${o.votes}${who ? ` — ${who}` : ''})\n`;
      }).join('')
    : '';
  const reactions = (m.reactions || []).map((r) => {
    const who = (r.by || []).map((v) => label(v)).join(', ');
    return who ? `${r.emoji} ${who}` : r.emoji;
  }).join(' · ');
  const decision = m.decision
    ? `Decision ${m.decision.id}${m.decision.agreed_at ? ' (agreed)' : ''}: ${m.decision.prompt}\n` + (m.decision.positions || []).map((pos) => {
        const mark = pos.stance === 'agree' ? '✓' : '✗';
        return `- ${label(pos.participant)} ${mark}${pos.note ? ` ${pos.note}` : ''}\n`;
      }).join('')
    : '';
  const extra = images + poll + decision + (reactions ? `[reactions: ${reactions}]\n` : '');
  return `#${m.id} [${time}]${room} ${label(m.sender)}${to}${reply}${pin}:\n${m.text}${m.text && extra ? '\n' : ''}${extra || '\n'}`;
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
    if (opts.room) body.room = opts.room;
    const replyTo = opts['reply-to'];
    if (replyTo !== undefined) {
      // Checked here, before any image is uploaded for a message that would be refused.
      if (!/^[1-9]\d{0,14}$/.test(replyTo)) usage('--reply-to needs a message id, for example --reply-to 45');
      body.reply_to = Number(replyTo);
    }
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
    const asReply = message.reply_to ? ` in reply to #${message.reply_to}` : '';
    if (!opts.json && message.recipient) await loadLabels();
    const inRoom = message.room && message.room !== 'main' ? ` in ${message.room}` : '';
    console.log(opts.json ? JSON.stringify(message) : `sent #${message.id}${message.recipient ? ` to ${label(message.recipient)}` : ''}${inRoom}${asReply}${withImages}${message.pinned_at ? ' (pinned)' : ''}`);
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
    if (opts['up-to'] !== undefined) {
      if (opts.peek) usage('read --peek cannot be combined with --up-to');
      if (!/^[1-9]\d{0,14}$/.test(opts['up-to'] || '')) usage('read --up-to needs a message id');
      const data = await (await call('/api/read', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.room ? { upTo: Number(opts['up-to']), room: opts.room } : { upTo: Number(opts['up-to']) }) })).json();
      if (opts.json) console.log(JSON.stringify(data.read));
      else console.log(`read up to #${data.read.up_to}${data.read.room && data.read.room !== 'main' ? ` in ${data.read.room}` : ''}`);
      return;
    }
    const data = await (await call(`/api/messages${query({ since: opts.since, to: opts.to, limit: opts.limit, room: opts.room, markRead: opts.peek ? undefined : '1' })}`)).json();
    if (opts.json) console.log(JSON.stringify(data.messages));
    else { if (data.messages.length) await loadLabels(); for (const m of data.messages) console.log(fmt(m)); }
    const last = data.messages.at(-1)?.id ?? opts.since ?? 0;
    console.error(`next: --since ${last}`);
    return;
  }

  if (cmd === 'search') {
    const q = args.join(' ').trim();
    if (!q) usage('search needs at least one word, for example: search "storage images"');
    const data = await (await call(`/api/messages${query({ q, to: opts.to, limit: opts.limit, room: opts.room, decisions: opts.decisions ? '1' : undefined, pinned: opts.pinned ? '1' : undefined })}`)).json();
    if (opts.json) console.log(JSON.stringify(data.messages));
    else { if (data.messages.length) await loadLabels(); for (const m of data.messages) console.log(fmt(m)); }
    // Newest first. The count goes to stderr, so stdout holds nothing but the messages.
    console.error(data.messages.length ? `${data.messages.length} found, newest first` : 'nothing found');
    return;
  }

  if (cmd === 'wait') {
    const timeoutMs = Number(opts.timeout ?? 600) * 1000;
    const deadline = Date.now() + timeoutMs;
    let since = opts.since;
    let me;
    const markRead = opts.peek ? undefined : '1';
    if (since === undefined) {
      // Only find the watermark; this request is not a delivery, so it does not mark as read.
      const data = await (await call(`/api/messages${query({ limit: 1, room: opts.room })}`)).json();
      since = data.messages.at(-1)?.id ?? 0;
      me = data.me;
    }
    while (Date.now() < deadline) {
      const data = await (await call(`/api/messages${query({ since, room: opts.room, markRead })}`)).json();
      me = data.me;
      const target = opts.to ? opts.to.replace(/^@/, '').toLowerCase() : me;
      const hits = data.messages.filter((m) => m.sender !== me && (m.recipient === target || (!opts.to && m.recipient === null)));
      if (data.messages.length) since = data.messages.at(-1).id;
      if (hits.length) {
        if (opts.json) console.log(JSON.stringify(hits));
        else { await loadLabels(); for (const m of hits) console.log(fmt(m)); }
        console.error(`next: --since ${since}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.error(`hub: no new message within ${timeoutMs / 1000}s. next: --since ${since}`);
    process.exit(2);
  }


  if (cmd === 'status') {
    if (opts.clear) {
      if (args.length || opts.ttl !== undefined) usage('status --clear takes no text or --ttl');
      const data = await (await call('/api/status', { method: 'DELETE' })).json();
      console.log(opts.json ? JSON.stringify(data) : (data.cleared ? 'status cleared' : 'no active status to clear'));
      return;
    }
    if (!args.length) {
      if (opts.ttl !== undefined) usage('status --ttl requires text');
      const data = await (await call('/api/status')).json();
      if (opts.json) console.log(JSON.stringify(data.statuses));
      else if (!data.statuses.length) console.log('no active status');
      else { await loadLabels(); for (const s of data.statuses) console.log(`${label(s.participant)}: ${s.text} (expires ${s.expires_at})`); }
      return;
    }
    const text = args.join(' ').replace(/[\r\n\t]+/g, ' ').trim();
    if (!text) usage('status needs non-empty text or --clear');
    if ([...text].length > 80) fail(`status text must be at most 80 characters (got ${[...text].length})`);
    const body = { text };
    if (opts.ttl !== undefined) {
      if (!/^\d+$/.test(opts.ttl)) usage('--ttl must be a whole number of seconds (30–1800)');
      body.ttlSeconds = Number(opts.ttl);
    }
    const { status } = await (await call('/api/status', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    console.log(opts.json ? JSON.stringify(status) : `status set: ${status.text} (expires ${status.expires_at})`);
    return;
  }


  if (cmd === 'roadmap') {
    // roadmap                                         the cards, by column
    // roadmap add <done|now|next|later> <title> [--note text] [--owner name]
    // roadmap move <rm_id> <column>                   to the end of that column
    // roadmap drop <rm_id>                            remove a card
    const [sub, ...rest] = args;
    const COLS = ['done', 'now', 'next', 'later'];
    if (!sub) {
      const { items } = await (await call('/api/roadmap')).json();
      if (opts.json) { console.log(JSON.stringify(items)); return; }
      await loadLabels();
      for (const col of COLS) {
        const list = items.filter((i) => i.column === col);
        console.log(`${col} (${list.length})`);
        for (const i of list) console.log(`  ${i.id}  ${i.title}${i.note ? ` · ${i.note}` : ''}${i.owner ? ` [${label(i.owner)}]` : ''}`);
      }
      return;
    }
    if (sub === 'add') {
      const [col, ...words] = rest;
      if (!COLS.includes(col) || !words.length) usage('roadmap add <done|now|next|later> <title> [--note text] [--owner name]');
      const body = { column: col, title: words.join(' ') };
      if (opts.note !== undefined) body.note = opts.note;
      if (opts.owner !== undefined) body.owner = opts.owner;
      const { item } = await (await call('/api/roadmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      console.log(opts.json ? JSON.stringify(item) : `added ${item.id} to ${item.column}: ${item.title}`);
      return;
    }
    if (sub === 'move') {
      const [id, col] = rest;
      if (!id || !COLS.includes(col)) usage('roadmap move <rm_id> <done|now|next|later>');
      const { item } = await (await call(`/api/roadmap/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ column: col }) })).json();
      console.log(opts.json ? JSON.stringify(item) : `moved ${item.id} to ${item.column}`);
      return;
    }
    if (sub === 'claim' || sub === 'release') {
      // roadmap claim <rm_id> --note "exists, small fix"   look first, then claim: the first claim wins
      const [id] = rest;
      if (!id) usage(`roadmap ${sub} <rm_id>${sub === 'claim' ? ' [--note "exists, small fix" | "new"]' : ''}`);
      const res = await fetch(`${base}/api/roadmap/${encodeURIComponent(id)}/claim`, {
        method: sub === 'claim' ? 'POST' : 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: sub === 'claim' ? JSON.stringify(opts.note !== undefined ? { note: opts.note } : {}) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { await loadLabels(); fail(`not yours: ${id} is ${label(data.owner)}'s. Nothing changed.`); }
      if (!res.ok) fail(data.error || `HTTP ${res.status}`);
      console.log(opts.json ? JSON.stringify(data.item) : sub === 'claim' ? `claimed ${id}: ${data.item.title}${data.item.note ? ` · ${data.item.note}` : ''}` : `released ${id}`);
      return;
    }
    if (sub === 'progress') {
      // roadmap progress <rm_id> <0-100|-> [status line]   your card only; «-» clears the bar
      const [id, pct, ...words] = rest;
      if (!id || pct === undefined || !(pct === '-' || /^\d{1,3}$/.test(pct))) usage('roadmap progress <rm_id> <0-100|-> [status line]');
      const res = await fetch(`${base}/api/roadmap/${encodeURIComponent(id)}/progress`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: pct === '-' ? null : Number(pct), ...(words.length ? { status: words.join(' ') } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) fail(data.error || `HTTP ${res.status}`);
      console.log(opts.json ? JSON.stringify(data.item) : `${id}: ${data.item.progress ?? '–'}%${data.item.status ? ` · ${data.item.status}` : ''}`);
      return;
    }
    if (sub === 'drop') {
      const [id] = rest;
      if (!id) usage('roadmap drop <rm_id>');
      await call(`/api/roadmap/${encodeURIComponent(id)}`, { method: 'DELETE' });
      console.log(`removed ${id}`);
      return;
    }
    usage('roadmap | roadmap add <column> <title> | roadmap claim <id> [--note t] | roadmap release <id> | roadmap move <id> <column> | roadmap drop <id>');
  }


  if (cmd === 'streak') {
    // streak                    the streak now, the record, and the last breaks
    // streak break <reason>     end it: you needed the orchestrator to unblock something (be honest)
    if (args[0] === 'break') {
      const reason = args.slice(1).join(' ').replace(/[\r\n\t]+/g, ' ').trim();
      if (!reason) usage('streak break <reason>: why the orchestrator had to step in');
      const data = await (await call('/api/streak/break', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })).json();
      console.log(opts.json ? JSON.stringify(data.break) : `streak ended: ${data.break.reason}`);
      return;
    }
    if (args.length) usage('streak | streak break <reason>');
    const s = await (await call('/api/streak')).json();
    if (opts.json) { console.log(JSON.stringify(s)); return; }
    console.log(`streak: ${s.current} now · record ${s.record}${s.problem ? ` (${s.problem})` : ''}`);
    await loadLabels();
    for (const p of s.points.filter((x) => x.break).slice(-5)) console.log(`  ended at ${p.break.ended} by ${label(p.break.by)}: ${p.break.reason}`);
    return;
  }


  if (cmd === 'flight') {
    // flight                       everyone's work in flight
    // flight working <text>        what you are on now (the clock starts when the text changes)
    // flight waiting <text>        what you wait for: a review, CI, the orchestrator
    // flight idle                  nothing in flight
    const [state, ...rest] = args;
    if (!state) {
      const data = await (await call('/api/flight')).json();
      if (opts.json) console.log(JSON.stringify(data.flights));
      else if (!data.flights.length) console.log('no work in flight');
      else { await loadLabels(); for (const f of data.flights) console.log(`${label(f.participant)}: ${f.state}${f.text ? ` · ${f.text}` : ''} (since ${f.since})`); }
      return;
    }
    if (!['working', 'waiting', 'idle'].includes(state)) usage('flight working <text> | flight waiting <text> | flight idle');
    const text = rest.join(' ').replace(/[\r\n\t]+/g, ' ').trim();
    if (state === 'idle' && text) usage('flight idle takes no text');
    if (state !== 'idle' && !text) usage(`flight ${state} needs a text: what on`);
    if ([...text].length > 80) fail(`flight text must be at most 80 characters (got ${[...text].length})`);
    const { flight } = await (await call('/api/flight', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state === 'idle' ? { state } : { state, text }),
    })).json();
    console.log(opts.json ? JSON.stringify(flight) : `flight: ${flight.state}${flight.text ? ` · ${flight.text}` : ''} (since ${flight.since})`);
    return;
  }


  if (cmd === 'poll') {
    if (opts.close !== undefined) {
      if (args.length || opts.to !== undefined) usage('poll --close takes a poll id and no question');
      if (!/^poll_[a-z0-9]{8,48}$/.test(opts.close || '')) usage('poll --close needs a poll id (poll_…)');
      const data = await (await call(`/api/polls/${opts.close}/close`, { method: 'POST' })).json();
      const { poll, message } = data;
      console.log(opts.json ? JSON.stringify(data) : (message
        ? `poll closed: ${poll.question} (result #${message.id})`
        : `poll closed: ${poll.question}`));
      return;
    }
    if (args.length < 3) usage('poll needs a question and at least two options');
    const question = args[0].replace(/[\r\n\t]+/g, ' ').trim();
    const options = args.slice(1).map((o) => o.replace(/[\r\n\t]+/g, ' ').trim());
    if (!question) usage('poll needs a non-empty question');
    if ([...question].length > 200) fail(`poll question must be at most 200 characters (got ${[...question].length})`);
    if (options.some((o) => !o)) usage('poll options must be non-empty');
    if (options.some((o) => [...o].length > 80)) fail('each poll option must be at most 80 characters');
    if (new Set(options).size !== options.length) fail('each poll option must be different');
    const body = { question, options };
    if (opts.to) body.to = opts.to;
    if (opts.room) body.room = opts.room;
    const { message, poll } = await (await call('/api/polls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    console.log(opts.json ? JSON.stringify({ message, poll }) : `poll ${poll.id} on #${message.id}: ${poll.question}`);
    return;
  }

  if (cmd === 'vote') {
    if (!/^poll_[a-z0-9]{8,48}$/.test(args[0] || '')) usage('vote needs a poll id (poll_…)');
    if (opts.clear) {
      if (args.length !== 1) usage('vote --clear takes a poll id and no option number');
      const data = await (await call(`/api/polls/${args[0]}/vote`, { method: 'DELETE' })).json();
      console.log(opts.json ? JSON.stringify(data) : (data.withdrawn ? 'vote withdrawn' : 'no vote to withdraw'));
      return;
    }
    if (!/^[1-9]\d*$/.test(args[1] || '') || args.length !== 2) usage('vote needs a poll id and a 1-based option number');
    const { poll } = await (await call(`/api/polls/${args[0]}/vote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option: Number(args[1]) }),
    })).json();
    const picked = poll.options.find((o) => o.index === Number(args[1]));
    console.log(opts.json ? JSON.stringify(poll) : `voted ${args[1]}: ${picked ? picked.text : args[1]}`);
    return;
  }

  if (cmd === 'pin' || cmd === 'unpin') {
    if (!/^\d+$/.test(args[0] || '')) usage(`${cmd} needs a message id`);
    await call(`/api/messages/${args[0]}/pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: cmd === 'pin' }),
    });
    console.log(`${cmd}ned #${args[0]}`);
    return;
  }

  if (cmd === 'react' || cmd === 'unreact') {
    if (!/^\d+$/.test(args[0] || '')) usage(`${cmd} needs a message id and an emoji`);
    const emoji = args.slice(1).join(' ').trim();
    if (!emoji) usage(`${cmd} needs a message id and an emoji`);
    const { message } = await (await call(`/api/messages/${args[0]}/reactions/${encodeURIComponent(emoji)}`, {
      method: cmd === 'react' ? 'PUT' : 'DELETE',
    })).json();
    if (opts.json) console.log(JSON.stringify(message));
    else {
      // The server stores the catalogue form (a heart may gain or lose a variation selector).
      // Match on that, and report the emoji and count from the answer.
      const fold = (s) => s.replaceAll('\uFE0F', '');
      const found = (message.reactions || []).find((r) => r.emoji === emoji || fold(r.emoji) === fold(emoji));
      const shown = found ? found.emoji : emoji;
      const n = found ? found.by.length : 0;
      console.log(cmd === 'react' ? `reacted ${shown} on #${args[0]} (${n})` : `removed ${emoji} from #${args[0]}`);
    }
    return;
  }

  if (cmd === 'decision') {
    const prompt = args.join(' ').trim();
    if (!prompt) usage('decision needs a prompt');
    const { message } = await (await call('/api/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.room ? { prompt, room: opts.room } : { prompt }),
    })).json();
    if (opts.json) console.log(JSON.stringify(message));
    else console.log(`decision ${message.decision?.id} as #${message.id}`);
    return;
  }

  if (cmd === 'agree' || cmd === 'object') {
    const id = args[0] || '';
    if (!/^decision_/.test(id)) usage(`${cmd} needs a decision id and, for object, a note`);
    const note = args.slice(1).join(' ').trim();
    if (cmd === 'object' && !note) usage('object needs a decision id and a note that says why');
    const body = { stance: cmd, note: note || undefined };
    const { decision, message } = await (await call(`/api/decisions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json();
    if (opts.json) console.log(JSON.stringify({ decision, message }));
    else console.log(`${cmd === 'agree' ? 'agreed' : 'objected'} on ${id}${decision.agreed_at ? ' — everyone has agreed' : ''}`);
    return;
  }

  if (cmd === 'participants') {
    const data = await (await call('/api/participants')).json();
    if (opts.json) console.log(JSON.stringify(data));
    else for (const p of data.participants) {
      // The label, when it is more than the name with a capital: david (human, shown as Orchestrator).
      const shownAs = p.label && p.label !== capital(p.name) ? `, shown as ${p.label}` : '';
      console.log(`${p.name} (${p.kind}${shownAs})${p.name === data.me ? '  ← you' : ''}`);
    }
    return;
  }

  if (cmd === 'rooms') {
    if (opts.create !== undefined) {
      if (args.length) usage('rooms --create takes the name as its value: rooms --create "Calm talk" [--id calm]');
      const body = opts.id ? { name: opts.create, id: opts.id } : { name: opts.create };
      const { room } = await (await call('/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      console.log(opts.json ? JSON.stringify(room) : `room ${room.id} created: ${room.name}`);
      return;
    }
    const data = await (await call('/api/rooms')).json();
    if (opts.json) console.log(JSON.stringify(data.rooms));
    else for (const r of data.rooms) console.log(`${r.id}  ${r.name}  (newest #${r.last_id})`);
    return;
  }

  if (cmd === 'wake') {
    const sub = args[0];
    if (sub === 'set') {
      const url = args[1];
      const secret = args[2] || process.env.WAKE_SECRET;
      if (!url || !secret) usage('wake set needs a https URL and a secret (second argument, or WAKE_SECRET). The secret is never printed.');
      const data = await (await call('/api/wake/target', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret }),
      })).json();
      // Never print a secret or the full URL; the server returns only the host.
      if (opts.json) console.log(JSON.stringify({ host: data.target?.host, updated_at: data.target?.updated_at }));
      else console.log(`wake-up target set: ${data.target.host}`);
      return;
    }
    if (sub === 'show') {
      const data = await (await call('/api/wake/target')).json();
      if (opts.json) console.log(JSON.stringify({ host: data.target?.host, updated_at: data.target?.updated_at }));
      else console.log(data.target.host);
      return;
    }
    if (sub === 'list') {
      const data = await (await call('/api/participants')).json();
      const list = data.participants || [];
      if (list.length && !('wake_target_host' in (list[0] || {}))) {
        console.error('hub: only a human can list wake-up targets');
        process.exit(1);
      }
      labels = new Map(list.filter((p) => typeof p.label === 'string' && p.label).map((p) => [p.name, p.label]));
      const rows = list
        .filter((p) => p.wake_target_host)
        .map((p) => ({ name: p.name, host: p.wake_target_host, set_at: p.wake_target_set_at }));
      if (opts.json) console.log(JSON.stringify(rows));
      else if (!rows.length) console.log('no wake-up targets are set');
      else for (const r of rows) {
        const when = r.set_at ? ` (set ${r.set_at})` : ' (from the environment)';
        console.log(`${label(r.name)}: ${r.host}${when}`);
      }
      return;
    }
    if (sub === 'test') {
      const data = await (await call('/api/wake/target/test', { method: 'POST' })).json();
      if (opts.json) console.log(JSON.stringify(data));
      else console.log(data.ok ? `wake-up test delivered (${data.status})` : 'wake-up test failed');
      return;
    }
    if (sub === 'clear') {
      const who = args[1];
      const path = who ? `/api/wake/target?participant=${encodeURIComponent(who.replace(/^@/, ''))}` : '/api/wake/target';
      const data = await (await call(path, { method: 'DELETE' })).json();
      if (opts.json) console.log(JSON.stringify(data));
      else if (who) console.log(data.cleared ? `wake-up target for ${label(who.replace(/^@/, ''))} cleared` : `no wake-up target was set for ${label(who.replace(/^@/, ''))}`);
      else console.log(data.cleared ? 'wake-up target cleared' : 'no wake-up target was set');
      return;
    }
    // wake [--since id] [--room id|all] [--wait s] [--limit n] [--json]: messages that should wake you.
    const data = await (await call(`/api/wake${query({ since: opts.since, wait: opts.wait, limit: opts.limit, room: opts.room })}`)).json();
    if (opts.json) console.log(JSON.stringify(data.messages));
    else {
      if (!data.messages.length) console.error('nothing to wake you');
      else { if (data.messages.length) await loadLabels(); for (const m of data.messages) console.log(fmt(m)); }
    }
    const last = data.messages.at(-1)?.id ?? opts.since ?? 0;
    console.error(`next: --since ${last}`);
    return;
  }

  if (cmd === 'export') {
    process.stdout.write(await (await call(`/api/export${query({ room: opts.room })}`)).text());
    return;
  }

  usage(cmd ? `unknown command "${cmd}"` : undefined);
}

main().catch((e) => { console.error(`hub: ${e.message}`); process.exit(1); });
