// The real route handlers with four made-up participants (memory store, throwaway tokens).
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { Attachment, Message, ParticipantStatus, Poll } from '../lib/core';
import { png } from './fixtures';

// Two people and two agents. None of them is one of the three names the project started with.
const PARTICIPANTS = 'ana-maria:human,ben:human,scout:agent,quill-2:agent';
const TOKENS: Record<string, string> = {
  'ana-maria': 'ana-maria-api-token-0123456789ab',
  ben: 'ben-api-token-0123456789abcdefgh',
  scout: 'scout-api-token-0123456789abcdef',
  'quill-2': 'quill-2-api-token-0123456789abcd',
};
// A token for a name that is not on the list: set in the environment, and still worth nothing.
const LEFTOVER_GROK_TOKEN = 'grok-leftover-token-0123456789ab';

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let participants: { GET: Handler };
let messages: { GET: Handler; POST: Handler };
let pin: { POST: Handler };
let exportRoute: { GET: Handler };
let status: { GET: Handler; PUT: Handler; DELETE: Handler };
let stream: { GET: Handler };
let uploads: { POST: Handler };
let image: { GET: Handler };
let polls: { POST: Handler };
let poll: { GET: Handler };
let vote: { POST: Handler; DELETE: Handler };
let close: { POST: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  for (const name of ['GROK_TOKEN', 'CLAUDE_TOKEN', 'DAVID_TOKEN']) delete process.env[name];
  process.env.PARTICIPANTS = PARTICIPANTS;
  process.env.ANA_MARIA_TOKEN = TOKENS['ana-maria'];
  process.env.BEN_TOKEN = TOKENS.ben;
  process.env.SCOUT_TOKEN = TOKENS.scout;
  process.env.QUILL_2_TOKEN = TOKENS['quill-2'];
  process.env.GROK_TOKEN = LEFTOVER_GROK_TOKEN;
  console.warn = () => {}; // silence the in-memory store warning
  participants = (await import('../app/api/participants/route')) as unknown as typeof participants;
  messages = (await import('../app/api/messages/route')) as unknown as typeof messages;
  pin = (await import('../app/api/messages/[id]/pin/route')) as unknown as typeof pin;
  exportRoute = (await import('../app/api/export/route')) as unknown as typeof exportRoute;
  status = (await import('../app/api/status/route')) as unknown as typeof status;
  stream = (await import('../app/api/stream/route')) as unknown as typeof stream;
  uploads = (await import('../app/api/attachments/route')) as unknown as typeof uploads;
  image = (await import('../app/api/attachments/[id]/route')) as unknown as typeof image;
  polls = (await import('../app/api/polls/route')) as unknown as typeof polls;
  poll = (await import('../app/api/polls/[id]/route')) as unknown as typeof poll;
  vote = (await import('../app/api/polls/[id]/vote/route')) as unknown as typeof vote;
  close = (await import('../app/api/polls/[id]/close/route')) as unknown as typeof close;
});

const URL_BASE = 'http://hub.test';
const auth = (who?: string): Record<string, string> => (who ? { Authorization: `Bearer ${TOKENS[who] ?? who}` } : {});
const who = (as?: string) => participants.GET(new Request(`${URL_BASE}/api/participants`, { headers: auth(as) }));
const get = (path: string, as?: string) => messages.GET(new Request(URL_BASE + path, { headers: auth(as) }));
const post = (body: unknown, as?: string) => messages.POST(new Request(`${URL_BASE}/api/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(as) }, body: JSON.stringify(body),
}));
const posted = async (body: unknown, as: string) => {
  const res = await post(body, as);
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { message: Message }).message;
};
const all = async (as: string) => ((await (await get('/api/messages?since=0', as)).json()) as { messages: Message[] }).messages;
const exported = async (as: string) => (await exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth(as) }))).text();

/** One request to every endpoint, as `as` (or without a token). */
function everyEndpoint(as?: string): [string, Promise<Response>][] {
  const json = { 'Content-Type': 'application/json', ...auth(as) };
  const id = 'att_0123456789abcdef01234567';
  const pollId = 'poll_0123456789abcdef01234567';
  return [
    ['GET /api/participants', who(as)],
    ['GET /api/messages', get('/api/messages', as)],
    ['POST /api/messages', post({ text: 'must not be stored' }, as)],
    ['POST /api/messages/1/pin', pin.POST(new Request(`${URL_BASE}/api/messages/1/pin`, { method: 'POST', headers: json, body: '{"pinned":true}' }), { params: Promise.resolve({ id: '1' }) })],
    ['GET /api/export', exportRoute.GET(new Request(`${URL_BASE}/api/export`, { headers: auth(as) }))],
    ['GET /api/status', status.GET(new Request(`${URL_BASE}/api/status`, { headers: auth(as) }))],
    ['PUT /api/status', status.PUT(new Request(`${URL_BASE}/api/status`, { method: 'PUT', headers: json, body: '{"text":"must not be stored"}' }))],
    ['DELETE /api/status', status.DELETE(new Request(`${URL_BASE}/api/status`, { method: 'DELETE', headers: auth(as) }))],
    ['GET /api/stream', stream.GET(new Request(`${URL_BASE}/api/stream`, { headers: auth(as) }))],
    ['POST /api/attachments', uploads.POST(new Request(`${URL_BASE}/api/attachments`, { method: 'POST', headers: auth(as), body: 'x' }))],
    ['GET /api/attachments/<id>', image.GET(new Request(`${URL_BASE}/api/attachments/${id}`, { headers: auth(as) }), { params: Promise.resolve({ id }) })],
    ['POST /api/polls', polls.POST(new Request(`${URL_BASE}/api/polls`, { method: 'POST', headers: json, body: '{"question":"must not be stored","options":["a","b"]}' }))],
    ['GET /api/polls/<id>', poll.GET(new Request(`${URL_BASE}/api/polls/${pollId}`, { headers: auth(as) }), { params: Promise.resolve({ id: pollId }) })],
    ['POST /api/polls/<id>/vote', vote.POST(new Request(`${URL_BASE}/api/polls/${pollId}/vote`, { method: 'POST', headers: json, body: '{"option":1}' }), { params: Promise.resolve({ id: pollId }) })],
    ['DELETE /api/polls/<id>/vote', vote.DELETE(new Request(`${URL_BASE}/api/polls/${pollId}/vote`, { method: 'DELETE', headers: auth(as) }), { params: Promise.resolve({ id: pollId }) })],
    ['POST /api/polls/<id>/close', close.POST(new Request(`${URL_BASE}/api/polls/${pollId}/close`, { method: 'POST', headers: auth(as) }), { params: Promise.resolve({ id: pollId }) })],
  ];
}

test('GET /api/participants needs a token', async () => {
  assert.equal((await who()).status, 401);
  assert.equal((await who('not-a-real-token-0123456789')).status, 401);
  assert.equal((await who(LEFTOVER_GROK_TOKEN)).status, 401, 'a token of a name that is not on the list');
});

test('GET /api/participants says who takes part and who is asking, and never shows a token', async () => {
  const res = await who('quill-2');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), {
    me: 'quill-2',
    participants: [
      { name: 'ana-maria', kind: 'human', color: 0 },
      { name: 'ben', kind: 'human', color: 1 },
      { name: 'scout', kind: 'agent', color: 2 },
      { name: 'quill-2', kind: 'agent', color: 3 },
    ],
  });
  for (const token of [...Object.values(TOKENS), LEFTOVER_GROK_TOKEN]) assert.ok(!text.includes(token), 'no token in the answer');
  assert.doesNotMatch(text, /token/i);
  // The same list for everyone; only `me` differs. A person and an agent are asked the same way.
  assert.equal(((await (await who('ana-maria')).json()) as { me: string }).me, 'ana-maria');
});

test('a new hub is welcomed with the configured names', async () => {
  const [welcome] = await all('ben');
  assert.equal(welcome.sender, 'hub');
  assert.match(welcome.text, /Ana-Maria, Ben, Scout and Quill-2 share this stream/);
  assert.match(welcome.text, /`@ana-maria`, `@ben`, `@scout` or `@quill-2`/);
  assert.doesNotMatch(welcome.text, /grok|claude|david/i);
});

test('messages to and from a fourth participant', async () => {
  const a = await posted({ text: '@ana-maria the tests are green' }, 'quill-2');
  assert.equal(a.sender, 'quill-2');
  assert.equal(a.recipient, 'ana-maria');
  const b = await posted({ text: 'thanks, please open the pull request', to: 'quill-2' }, 'ana-maria');
  assert.deepEqual([b.sender, b.recipient], ['ana-maria', 'quill-2']);
  const c = await posted({ text: '@Quill-2 DECISION: we ship on Friday' }, 'scout');
  assert.equal(c.recipient, 'quill-2');
  assert.equal(c.pinned_at, null, 'a capital letter in the name does not pin, as before');
  const d = await posted({ text: '@quill-2 DECISION: we ship on Friday' }, 'ben');
  assert.ok(d.pinned_at);
  const e = await posted({ text: 'for everyone' }, 'ben');
  assert.equal(e.recipient, null);

  const forQuill = (await (await get('/api/messages?since=0&to=quill-2', 'quill-2')).json()) as { me: string; messages: Message[]; pinned: Message[] };
  assert.equal(forQuill.me, 'quill-2');
  assert.deepEqual(forQuill.messages.map((m) => m.id), [b.id, c.id, d.id]);
  assert.deepEqual(forQuill.pinned.map((m) => m.id), [d.id]);
  assert.deepEqual((await (await get('/api/messages?since=0&to=@Ana-Maria', 'scout')).json() as { messages: Message[] }).messages.map((m) => m.id), [a.id]);

  const md = await exported('scout');
  assert.match(md, /\*\*Quill-2 → Ana-Maria\*\*/);
  assert.match(md, /\*\*Ana-Maria → Quill-2\*\*/);
  assert.match(md, new RegExp(`- #${d.id} \\(Ben, `));
});

test('the sender still comes from the token, and only configured names can be addressed', async () => {
  const spoofed = await posted({ text: 'I am totally Ana', sender: 'ana-maria', from: 'ana-maria' }, 'scout');
  assert.equal(spoofed.sender, 'scout');
  for (const to of ['grok', 'claude', 'david', 'ana', 'hub', 'system', 'Mallory!']) {
    const res = await post({ text: 'x', to }, 'ben');
    assert.equal(res.status, 400, to);
    assert.equal(((await res.json()) as { error: string }).error, '"to" must be one of ana-maria, ben, scout, quill-2 (or left out for everyone).');
  }
  const filter = await get('/api/messages?to=grok', 'ben');
  assert.equal(filter.status, 400);
  assert.match(((await filter.json()) as { error: string }).error, /"to" must be one of ana-maria, ben, scout, quill-2/);
  // "@grok" at the start is just text here.
  assert.equal((await posted({ text: '@grok hello?' }, 'ben')).recipient, null);
  assert.equal((await post({ text: 'hi' }, LEFTOVER_GROK_TOKEN)).status, 401);
});

test('status and images work for any configured participant', async () => {
  const put = await status.PUT(new Request(`${URL_BASE}/api/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth('quill-2') }, body: JSON.stringify({ text: 'writing the tests' }),
  }));
  assert.equal(put.status, 200);
  const { statuses } = (await (await status.GET(new Request(`${URL_BASE}/api/status`, { headers: auth('ana-maria') }))).json()) as { statuses: ParticipantStatus[] };
  assert.deepEqual(statuses.map((s) => [s.participant, s.text]), [['quill-2', 'writing the tests']]);

  const up = await uploads.POST(new Request(`${URL_BASE}/api/attachments`, { method: 'POST', headers: auth('ana-maria'), body: new Uint8Array(await png()) }));
  assert.equal(up.status, 201);
  const attachment = (await up.json()) as Attachment;
  const download = (as: string) => image.GET(new Request(`${URL_BASE}/api/attachments/${attachment.id}`, { headers: auth(as) }), { params: Promise.resolve({ id: attachment.id }) });
  assert.equal((await download('scout')).status, 404, 'not linked yet: only the uploader sees it');
  assert.equal((await post({ text: 'mine now', attachments: [attachment.id] }, 'scout')).status, 403);
  const withImage = await posted({ text: '@scout see this', attachments: [attachment.id] }, 'ana-maria');
  assert.deepEqual(withImage.attachments.map((x) => x.id), [attachment.id]);
  assert.equal((await download('scout')).status, 200);
});

test('a poll among the four: a fourth participant creates it, votes are named, and closing it posts the result', async () => {
  const jsonAs = (as: string) => ({ 'Content-Type': 'application/json', ...auth(as) });
  const created = await polls.POST(new Request(`${URL_BASE}/api/polls`, { method: 'POST', headers: jsonAs('quill-2'), body: JSON.stringify({ question: 'Ship on Friday?', options: ['Yes', 'No'], to: 'ana-maria' }) }));
  assert.equal(created.status, 201, await created.clone().text());
  const made = (await created.json()) as { message: Message; poll: Poll };
  assert.deepEqual([made.message.sender, made.message.recipient, made.poll.creator], ['quill-2', 'ana-maria', 'quill-2']);
  const at = { params: Promise.resolve({ id: made.poll.id }) };
  const cast = (as: string, option: number) => vote.POST(new Request(`${URL_BASE}/api/polls/${made.poll.id}/vote`, { method: 'POST', headers: jsonAs(as), body: JSON.stringify({ option }) }), at);
  assert.equal((await cast('scout', 1)).status, 200);
  assert.equal((await cast('ana-maria', 1)).status, 200);
  assert.equal((await cast('ben', 2)).status, 200);
  // A name that is not a participant can't be asked, as with a message.
  const stranger = await polls.POST(new Request(`${URL_BASE}/api/polls`, { method: 'POST', headers: jsonAs('ben'), body: JSON.stringify({ question: 'Q?', options: ['A', 'B'], to: 'grok' }) }));
  assert.equal(stranger.status, 400);
  assert.match(((await stranger.json()) as { error: string }).error, /"to" must be one of ana-maria, ben, scout, quill-2/);

  // Only the creator closes it. Closing posts the result as a reply, written by the closer, with the voters' names.
  assert.notEqual((await close.POST(new Request(`${URL_BASE}/api/polls/${made.poll.id}/close`, { method: 'POST', headers: auth('ben') }), at)).status, 200);
  const closed = await close.POST(new Request(`${URL_BASE}/api/polls/${made.poll.id}/close`, { method: 'POST', headers: auth('quill-2') }), at);
  assert.equal(closed.status, 200, await closed.clone().text());
  const result = (await closed.json()) as { poll: Poll; message: Message };
  assert.ok(result.poll.closed_at);
  // Two votes in the same millisecond may come back in either order, so the order is not checked.
  assert.deepEqual(result.poll.options.map((o) => [...o.voters].sort()), [['ana-maria', 'scout'], ['ben']]);
  assert.deepEqual([result.message.sender, result.message.reply_to], ['quill-2', made.message.id]);
  assert.match(result.message.text, /Yes — 2 votes \((Scout, Ana-Maria|Ana-Maria, Scout)\)/);
  assert.match(result.message.text, /No — 1 vote \(Ben\)/);
  assert.doesNotMatch(result.message.text, /grok|claude|david/i);
  const md = await exported('ben');
  assert.match(md, /- 1\. Yes \(2 — (Scout, Ana-Maria|Ana-Maria, Scout)\)/);
});

test('messages of someone who is no longer a participant stay readable', async () => {
  // As if "former-member" had been on the list when these were written, and was taken off later.
  const { getStore } = await import('../lib/store');
  const store = await getStore();
  const old = await store.add({ sender: 'former-member', recipient: 'ben', text: 'DECISION: written before I left', pinned: true });
  assert.ok(old);

  const data = (await (await get('/api/messages?since=0', 'ben')).json()) as { messages: Message[]; pinned: Message[] };
  const found = data.messages.find((m) => m.id === old.id);
  assert.deepEqual([found?.sender, found?.recipient, found?.text], ['former-member', 'ben', 'DECISION: written before I left']);
  assert.ok(data.pinned.some((m) => m.id === old.id));
  assert.match(await exported('ben'), /\*\*Former-Member → Ben\*\*/);
  // They are not a participant: not on the list, and nobody can write to them or as them.
  const list = (await (await who('ben')).json()) as { participants: { name: string }[] };
  assert.ok(!list.participants.some((p) => p.name === 'former-member'));
  assert.equal((await post({ text: 'are you there?', to: 'former-member' }, 'ben')).status, 400);
  // The message can still be unpinned and pinned like any other.
  const unpin = await pin.POST(new Request(`${URL_BASE}/api/messages/${old.id}/pin`, { method: 'POST', headers: auth('ben'), body: '{"pinned":false}' }), { params: Promise.resolve({ id: String(old.id) }) });
  assert.equal(unpin.status, 200);
});

test('a broken setting answers 500 on every endpoint; only someone with a participant\'s token is told what is wrong', async () => {
  const before = (await all('ben')).length;
  const errors: string[] = [];
  const logError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  // What is changed, what the log and a participant are told, and whose tokens count as a participant's then.
  const broken: [Record<string, string | undefined>, RegExp, string[]][] = [
    [{ PARTICIPANTS: 'ana-maria:human,ben:human,scout:agent,quill-2:robot' }, /^Configuration error: PARTICIPANTS entry 4 \("quill-2"\) needs the kind human or agent/, ['ana-maria', 'ben', 'scout', 'quill-2']],
    [{ PARTICIPANTS: 'ana-maria:human' }, /^Configuration error: PARTICIPANTS must list at least 2 participants/, ['ana-maria']],
    [{ PARTICIPANTS: `${PARTICIPANTS},all:agent` }, /^Configuration error: PARTICIPANTS entry 5 uses the name "all", which is reserved/, ['ana-maria', 'ben', 'scout', 'quill-2']],
    [{ PARTICIPANTS: 'Ana Maria=human;ben' }, /^Configuration error: PARTICIPANTS must list at least 2 participants/, []],
    [{ SCOUT_TOKEN: undefined }, /^Configuration error: PARTICIPANTS lists scout, but SCOUT_TOKEN is not set or shorter than 16 characters/, ['ana-maria', 'ben', 'quill-2']],
    [{ SCOUT_TOKEN: 'short-secret' }, /^Configuration error: PARTICIPANTS lists scout, but SCOUT_TOKEN is not set/, ['ana-maria', 'ben', 'quill-2']],
    [{ SCOUT_TOKEN: TOKENS.ben }, /^Configuration error: BEN_TOKEN and SCOUT_TOKEN hold the same token/, ['ana-maria', 'ben', 'quill-2']],
  ];
  const PLAIN = 'Configuration error. The details are in the server log.';
  const secrets = [...Object.values(TOKENS), LEFTOVER_GROK_TOKEN, 'short-secret'];
  try {
    for (const [change, expected, insiders] of broken) {
      const saved = Object.fromEntries(Object.keys(change).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(change)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      try {
        // Nobody is let in, whoever asks, and nobody gets a 401 that would hide that the hub is down.
        for (const as of ['ana-maria', 'ben', 'scout', 'quill-2', LEFTOVER_GROK_TOKEN, 'short-secret', 'not-a-real-token-0123456789', undefined]) {
          for (const [endpoint, pending] of everyEndpoint(as)) {
            const res = await pending;
            assert.equal(res.status, 500, `${endpoint} as ${as}`);
            const body = await res.text();
            const { error } = JSON.parse(body) as { error: string };
            if (as && insiders.includes(as)) {
              // A participant with their token: told which setting to fix.
              assert.match(error, expected, `${endpoint} as ${as}`);
            } else {
              // A wrong token, a token that is not on the list, or none: a 500 that names nothing.
              assert.equal(error, PLAIN, `${endpoint} as ${as}`);
              assert.doesNotMatch(body, /PARTICIPANTS|_TOKEN|ana|ben|scout|quill|entry|human|agent/i, `${endpoint} as ${as}`);
            }
            for (const secret of secrets) assert.ok(!body.includes(secret), `${endpoint} shows a token`);
          }
        }
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    }
  } finally {
    console.error = logError;
  }
  // The log has the details of each problem once, not once per request, and never a token. (The
  // missing and the too-short token are the same problem with the same message, so they share a
  // line; so do the two lists with too few entries, which come one after a different problem.)
  assert.equal(errors.length, 6);
  assert.ok(errors.every((line, i) => line !== errors[i - 1]), 'the same problem twice in a row is one line');
  for (const [, expected] of broken) assert.ok(errors.some((line) => expected.test(line.replace('[trialog] ', ''))), String(expected));
  for (const line of errors) {
    assert.match(line, /^\[trialog\] Configuration error: /);
    for (const secret of secrets) assert.ok(!line.includes(secret));
  }
  // Fixed again: everything works, and nothing was stored in the meantime.
  assert.equal((await who('ben')).status, 200);
  assert.equal((await all('ben')).length, before);
});
