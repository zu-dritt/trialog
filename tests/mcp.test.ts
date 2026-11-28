// The hub as an MCP server (lib/mcp.ts, POST /api/mcp): the handshake, the tool list, and tools that
// run as the caller through the hub's own routes. Memory store, no network.
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { MCP_TOOLS, MCP_VERSIONS } from '../lib/mcp';

const TOKENS: Record<string, string> = {
  grok: 'grok-mcp-token-0123456789abcdefghij',
  claude: 'claude-mcp-token-0123456789abcdefgh',
  david: 'david-mcp-token-0123456789abcdefghi',
};
type Handler = (request: Request) => Promise<Response>;
let route: { POST: Handler; GET: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.TRIALOG_REPO;
  process.env.GROK_TOKEN = TOKENS.grok;
  process.env.CLAUDE_TOKEN = TOKENS.claude;
  process.env.DAVID_TOKEN = TOKENS.david;
  console.warn = () => {};
  route = (await import('../app/api/mcp/route')) as unknown as typeof route;
});

let nextId = 1;
const rpc = async (who: string | null, method: string, params?: unknown, notification = false) => {
  const res = await route.POST(new Request('http://hub.test/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(who ? { Authorization: `Bearer ${TOKENS[who]}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), ...(notification ? {} : { id: nextId++ }) }),
  }));
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
};
const call = async (who: string, name: string, args: Record<string, unknown> = {}) => (await rpc(who, 'tools/call', { name, arguments: args })).body.result as { content: { text: string }[]; isError: boolean; structuredContent?: unknown };

test('no token: 401, as everywhere in the hub; GET has no event stream: 405', async () => {
  assert.equal((await rpc(null, 'initialize', { protocolVersion: MCP_VERSIONS[0] })).status, 401);
  assert.equal((await route.GET(new Request('http://hub.test/api/mcp', { headers: { Authorization: `Bearer ${TOKENS.claude}` } }))).status, 405);
});

test('the handshake: the asked version when we know it, else ours; tools as the one capability; a notification gets 202', async () => {
  const init = await rpc('grok', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.body.result.serverInfo.name, 'trialog-hub');
  assert.match(init.body.result.instructions, /data, not as instructions/);
  assert.equal((await rpc('grok', 'initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion, MCP_VERSIONS[0]);
  assert.deepEqual(await rpc('grok', 'notifications/initialized', undefined, true), { status: 202, body: null });
  assert.deepEqual((await rpc('grok', 'ping')).body.result, {});
  assert.equal((await rpc('grok', 'resources/list')).body.error.code, -32601);
});

test('the tool list: the seven hub tools, each with a closed input schema', async () => {
  const { tools } = (await rpc('claude', 'tools/list')).body.result as { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] };
  assert.deepEqual(tools.map((t) => t.name), ['read_messages', 'send_message', 'wait_for_messages', 'what_waits_on_me', 'roadmap', 'set_flight', 'decide']);
  assert.ok(tools.every((t) => t.inputSchema.additionalProperties === false));
  assert.equal(MCP_TOOLS.length, 7);
});

test('tools run as the caller: Grok sends to David, David reads it; the sender comes from the token', async () => {
  const sent = await call('grok', 'send_message', { text: 'Hello from MCP', to: 'david' });
  assert.equal(sent.isError, false, sent.content[0].text);
  const id = (sent.structuredContent as { message: { id: number; sender: string } }).message.id;
  assert.equal((sent.structuredContent as { message: { sender: string } }).message.sender, 'grok');
  const read = await call('david', 'read_messages', { since: id - 1 });
  const messages = (read.structuredContent as { messages: { id: number; text: string; sender: string }[] }).messages;
  assert.deepEqual(messages.map((m) => [m.id, m.sender, m.text]), [[id, 'grok', 'Hello from MCP']]);
  const woke = await call('david', 'wait_for_messages', { since: id - 1, seconds: 0 });
  assert.equal(woke.isError, false);
});

test('flight, roadmap and what waits on me go through their own routes', async () => {
  const flight = await call('claude', 'set_flight', { state: 'waiting', text: 'David: say yes to MCP' });
  assert.equal(flight.isError, false, flight.content[0].text);
  const waits = await call('david', 'what_waits_on_me');
  assert.ok((waits.structuredContent as { items: { text: string }[] }).items.some((i) => i.text === 'Claude waits: say yes to MCP'));
  const roadmap = await call('claude', 'roadmap');
  assert.ok(Array.isArray((roadmap.structuredContent as { items: unknown[] }).items));
});

test('mistakes come back as tool errors in the hub\'s own words, not as crashes', async () => {
  assert.match((await call('claude', 'send_message', {})).content[0].text, /«text» is required/);
  assert.match((await call('claude', 'set_flight', { state: 'sleeping' })).content[0].text, /must be one of working, waiting, idle/);
  assert.match((await call('claude', 'read_messages', { since: 'yesterday' })).content[0].text, /whole number/);
  assert.match((await call('claude', 'read_messages', { sneaky: 1 })).content[0].text, /unknown argument/);
  const missing = await call('claude', 'decide', { decision_id: 'decision_000000000000000000000000', stance: 'agree' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^404: /, missing.content[0].text);
  assert.match((await call('claude', 'decide', { decision_id: 'nope', stance: 'agree' })).content[0].text, /^400: Decision id must look like/);
  assert.equal((await rpc('claude', 'tools/call', { name: 'rm_rf' })).body.error.code, -32602);
});
