import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_VERSION, MAX_LIST_BYTES, MAX_TOOLS, MODERN_VERSION, connectStdio,
} from '../src/kinds/engines/mcp-client.js';
import { tempDir } from './temp.js';

const STAND_IN = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ENV = { PATH: process.env.PATH, LANG: 'C' };
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const FAKE_SECRET = 'mcp-S3CR3T-stderr-7c2d-unmistakable';

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // an empty line, or one the stand-in is still writing
    }
  }
  return entries;
}

// A stand-in server with these options, its working folder and what it recorded.
function standIn(options = {}) {
  const dir = fs.realpathSync(tempDir('ks-mcpc-'));
  const record = path.join(dir, 'record.jsonl');
  const lines = () => readLines(record);
  return {
    dir,
    argv: [process.execPath, STAND_IN, JSON.stringify({ record, ...options })],
    lines,
    got: () => lines().filter((entry) => entry.got !== undefined).map((entry) => entry.got),
    pid: () => lines().find((entry) => entry.event === 'start')?.pid,
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, what, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function open(t, options, extra = {}) {
  const server = standIn(options);
  const client = await connectStdio({
    argv: server.argv, env: ENV, cwd: server.dir, limitMs: 20000, ...extra,
  });
  t.after(() => client.close());
  return { server, client };
}

const callsOf = (server) => server.got().filter((message) => message.method === 'tools/call');
const cancelsOf = (server) => server.got().filter((message) => message.method === 'notifications/cancelled');
const textOf = (answer) => answer.result.content[0].text;

test('modern: initialize is refused, server/discover finds the era, and every later request carries the protocol version', async (t) => {
  const server = standIn({ serverInfo: { name: 'shop-tools', version: '2.0.0' } });
  const client = await connectStdio({ argv: server.argv, env: ENV, cwd: server.dir });
  t.after(() => client.close());
  assert.equal(client.era, MODERN_VERSION);
  assert.deepEqual(client.serverInfo, { name: 'shop-tools', version: '2.0.0' });
  assert.deepEqual(await client.listTools(), {
    tools: [1, 2, 3].map((n) => ({
      name: `tool_${n}`, description: `Tool number ${n}`, inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
    })),
    capped: false,
  });
  assert.deepEqual(await client.callTool('tool_2', { key: 'SHOP-1' }, { timeoutMs: 10000, maxBytes: 1000 }), {
    result: { content: [{ type: 'text', text: 'called tool_2 with {"key":"SHOP-1"}' }], isError: false, resultType: 'complete' },
    truncated: false,
  });
  assert.equal(await client.ping(), true);
  assert.deepEqual(await client.close(), { code: 0, signal: null });

  const got = server.got();
  assert.deepEqual(got.map((message) => message.method), ['initialize', 'server/discover', 'tools/list', 'tools/call', 'ping']);
  assert.deepEqual(got[0].params, {
    protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'ksproxy', version: PKG.version },
  });
  assert.deepEqual(got[1].params._meta, {
    [VERSION_KEY]: MODERN_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'ksproxy', version: PKG.version },
    'io.modelcontextprotocol/clientCapabilities': {},
  });
  for (const message of got.slice(1)) assert.equal(message.params._meta[VERSION_KEY], MODERN_VERSION);
  assert.deepEqual(got[3].params.arguments, { key: 'SHOP-1' });
  assert.deepEqual(got.map((message) => message.id), [1, 2, 3, 4, 5]);
});

test('modern: each error a modern-only server gives to initialize leads to server/discover', async (t) => {
  for (const initializeError of ['method-not-found', 'unsupported-version']) {
    const { server, client } = await open(t, { initializeError });
    assert.equal(client.era, MODERN_VERSION, initializeError);
    assert.deepEqual(server.got().map((message) => message.method), ['initialize', 'server/discover'], initializeError);
  }
});

test('legacy: initialize gives the era, notifications/initialized follows, no request carries _meta and nothing unknown is sent', async (t) => {
  const { server, client } = await open(t, { era: 'legacy', unknownMethod: 'exit' });
  assert.equal(client.era, LEGACY_VERSION);
  assert.deepEqual(client.serverInfo, { name: 'stand-in', version: '1.0.0' });
  assert.equal((await client.listTools()).tools.length, 3);
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), {
    result: { content: [{ type: 'text', text: 'called tool_1 with {}' }], isError: false }, truncated: false,
  });
  assert.equal(await client.ping(), true);
  await client.close();
  const got = server.got();
  assert.deepEqual(got.map((message) => message.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping']);
  assert.equal(got[1].id, undefined);
  for (const message of got) assert.equal(message.params?._meta, undefined);
});

test('legacy: the era is the version the server answers, and serverInfo is cleaned and clipped', async (t) => {
  const serverInfo = { name: `shop\u001b[31m-tools\u0007${'n'.repeat(100)}`, version: 7 };
  const { client } = await open(t, { era: 'legacy', version: '2025-06-18', serverInfo });
  assert.equal(client.era, '2025-06-18');
  assert.equal(client.serverInfo.name.length, 64);
  assert.ok(client.serverInfo.name.startsWith('shop-toolsnnn'), client.serverInfo.name);
  assert.equal(client.serverInfo.version, '');
  const { client: bare } = await open(t, { era: 'legacy', serverInfo: 'none' });
  assert.deepEqual(bare.serverInfo, { name: '', version: '' });
});

test('the start fails when initialize gets a line that is not JSON, gets no version, or neither era is accepted', async () => {
  const cases = [
    [{ initializeError: 'not-json' }, /^Error: the MCP server sent a line that is not JSON in answer to initialize$/],
    [{ era: 'legacy', initialize: 'no-version' }, /^Error: the MCP server answered initialize without a protocol version$/],
    [{ era: 'legacy', initialize: 'refuse' }, /^Error: the MCP server refused server\/discover: Server not initialized$/],
  ];
  for (const [options, expected] of cases) {
    const server = standIn(options);
    await assert.rejects(connectStdio({
      argv: server.argv, env: ENV, cwd: server.dir, limitMs: 20000,
    }), expected);
    await waitFor(() => server.pid() !== undefined && !alive(server.pid()), 'the stand-in to be stopped');
  }
});

test('listTools reads every page and passes each cursor back', async (t) => {
  const { server, client } = await open(t, { tools: 7, pageSize: 3 });
  const { tools, capped } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [1, 2, 3, 4, 5, 6, 7].map((n) => `tool_${n}`));
  assert.equal(capped, false);
  const lists = server.got().filter((message) => message.method === 'tools/list');
  assert.deepEqual(lists.map((message) => message.params.cursor), [undefined, '3', '6']);
});

test(`listTools stops at ${MAX_TOOLS} tools and says when the server had more`, async (t) => {
  const { client } = await open(t, { tools: 2001, pageSize: 1000 });
  const over = await client.listTools();
  assert.equal(over.tools.length, MAX_TOOLS);
  assert.equal(over.tools.at(-1).name, 'tool_2000');
  assert.equal(over.capped, true);
  const { client: exact } = await open(t, { tools: 2000, pageSize: 1000 });
  const full = await exact.listTools();
  assert.equal(full.tools.length, MAX_TOOLS);
  assert.equal(full.capped, false);
});

test('listTools: an empty page or a cursor that is not a string ends the list; a page without a list or an error throws', async (t) => {
  const { client: empty } = await open(t, { era: 'legacy', listAnswer: { result: { tools: [], nextCursor: 'again' } } });
  assert.deepEqual(await empty.listTools(), { tools: [], capped: false });
  const { client: odd } = await open(t, { era: 'legacy', listAnswer: { result: { tools: [{ name: 'a' }], nextCursor: 5 } } });
  assert.deepEqual(await odd.listTools(), { tools: [{ name: 'a' }], capped: false });
  const { client: none } = await open(t, { era: 'legacy', listAnswer: { result: { tools: 'many' } } });
  await assert.rejects(none.listTools(), /^Error: the MCP server answered tools\/list without a list of tools$/);
  const { client: refused } = await open(t, { era: 'legacy', listAnswer: { error: { code: -32603, message: 'it \u001b[31mbroke' } } });
  await assert.rejects(refused.listTools(), /^Error: the MCP server refused tools\/list: it broke$/);
});

test('a request from the server is answered: ping with an empty result, anything else as not supported, and the call goes on', async (t) => {
  const { server, client } = await open(t, { era: 'legacy', askInput: 'sampling/createMessage', pingClient: true });
  const answer = await client.callTool('tool_1', {}, { timeoutMs: 10000 });
  assert.deepEqual(answer.result.content, [{ type: 'text', text: 'answered after asking' }]);
  const answers = server.got().filter((message) => message.method === undefined);
  assert.deepEqual(answers.find((message) => message.id === 'ping-1'), { jsonrpc: '2.0', id: 'ping-1', result: {} });
  const refusal = answers.find((message) => message.id === 'ask-1');
  assert.equal(refusal.error.code, -32601);
  assert.equal(refusal.error.message, 'ksproxy does not support requests from an MCP server');
  assert.deepEqual(cancelsOf(server), []);
});

test('inputRequired comes only from a 2026-07-28 result whose resultType is input_required', async (t) => {
  const { client } = await open(t, { askInput: true });
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { inputRequired: true });
  const { client: legacy } = await open(t, { era: 'legacy', callAnswer: { result: { resultType: 'input_required', content: [] } } });
  assert.deepEqual(await legacy.callTool('tool_1', {}, { timeoutMs: 10000 }), {
    result: { resultType: 'input_required', content: [] }, truncated: false,
  });
});

test('notifications, answers to nothing and JSON that is not a message are read and dropped', async (t) => {
  const { client } = await open(t, { notify: true, image: true, isError: true });
  const answer = await client.callTool('tool_3', { key: 1 }, { timeoutMs: 10000 });
  assert.deepEqual(answer.result.content, [
    { type: 'text', text: 'called tool_3 with {"key":1}' },
    { type: 'image', data: Buffer.from('not a picture').toString('base64'), mimeType: 'image/png' },
  ]);
  assert.equal(answer.result.isError, true);
  assert.equal(answer.truncated, false);
  assert.equal(await client.ping(), true);
});

test('JSON-RPC errors are passed on with a number code and a text message, and an answer without a result is an error', async (t) => {
  const { client } = await open(t, { rpcError: 'no such issue' });
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { rpcError: { code: -32602, message: 'no such issue' } });
  const { client: odd } = await open(t, { callAnswer: { error: { code: 'x', message: 5 } } });
  assert.deepEqual(await odd.callTool('tool_1', {}, { timeoutMs: 10000 }), { rpcError: { code: null, message: '' } });
  for (const callAnswer of [{}, { result: 5 }, { result: [1] }, { error: null }]) {
    const { client: empty } = await open(t, { callAnswer });
    assert.deepEqual(await empty.callTool('tool_1', {}, { timeoutMs: 10000 }), {
      rpcError: { code: -32603, message: 'the MCP server sent an answer without a result' },
    }, JSON.stringify(callAnswer));
  }
});

test('maxBytes cuts the text of a result at a character boundary, leaves every later part out and marks it truncated', async (t) => {
  const { client } = await open(t, { bigAnswer: 5000 });
  const cut = await client.callTool('tool_1', {}, { timeoutMs: 10000, maxBytes: 1000 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.result.content[0].text, 'x'.repeat(1000));
  const whole = await client.callTool('tool_1', {}, { timeoutMs: 10000 });
  assert.equal(whole.result.content[0].text.length, 5000);
  assert.equal(whole.truncated, false);

  const content = [
    { type: 'text', text: 'abc' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: 'défg' },
    { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hij' } },
    { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA' } },
    { type: 'resource', resource: 'odd' },
    { type: 'text', text: 7 },
    5,
  ];
  const { client: parts } = await open(t, { era: 'legacy', callAnswer: { result: { content, structuredContent: { a: 1 } } } });
  const many = await parts.callTool('tool_1', {}, { timeoutMs: 10000, maxBytes: 5 });
  assert.equal(many.truncated, true);
  assert.deepEqual(many.result, {
    content: [content[0], content[1], { type: 'text', text: 'd' }],
    structuredContent: { a: 1 },
  });
  const some = await parts.callTool('tool_1', {}, { timeoutMs: 10000, maxBytes: 9 });
  assert.equal(some.truncated, true);
  // The cut is the end of the answer, where the core drops a piece of a secret it cut: no part comes after it.
  assert.deepEqual(some.result.content, [...content.slice(0, 3), { type: 'resource', resource: { uri: 'file:///a.txt', text: 'h' } }]);
  const used = await parts.callTool('tool_1', {}, { timeoutMs: 10000, maxBytes: 8 });
  assert.equal(used.truncated, true);
  assert.deepEqual(used.result.content, content.slice(0, 3));
  const fits = await parts.callTool('tool_1', {}, { timeoutMs: 10000, maxBytes: 11 });
  assert.equal(fits.truncated, false);
  assert.deepEqual(fits.result.content, content);
  const { client: bare } = await open(t, { era: 'legacy', callAnswer: { result: { structuredContent: { a: 1 } } } });
  assert.deepEqual(await bare.callTool('tool_1', {}, { timeoutMs: 10000, maxBytes: 1 }), {
    result: { structuredContent: { a: 1 } }, truncated: false,
  });
});

test('a line over maxMessageBytes is skipped up to its newline: the call in flight ends as too large and is cancelled', async (t) => {
  const { server, client } = await open(t, {}, { maxMessageBytes: 200000 });
  const answer = await client.callTool('tool_1', { standIn: { callLine: 'endless' } }, { timeoutMs: 20000 });
  assert.deepEqual(answer, { tooLarge: true });
  const [first] = callsOf(server);
  await waitFor(() => cancelsOf(server).some((message) => message.params.requestId === first.id), 'the call to be cancelled');
  const next = await client.callTool('tool_2', {}, { timeoutMs: 20000 });
  assert.equal(next.result.content[0].text, 'called tool_2 with {}');
});

test('an oversize line that no call is waiting for is dropped, and a tools/list page over the limit throws', async (t) => {
  const { client } = await open(t, { floodOnPing: 300000 }, { maxMessageBytes: 200000 });
  assert.equal(await client.ping(), true);
  assert.equal((await client.callTool('tool_1', {}, { timeoutMs: 10000 })).truncated, false);
  const { client: lists } = await open(t, { listAnswer: 'endless' }, { maxMessageBytes: 200000 });
  await assert.rejects(lists.listTools(), /^Error: the answer of the MCP server to tools\/list is larger than 200000 bytes$/);
});

test('a line that is not JSON ends the call in flight as an error, and the next call works', async (t) => {
  const { server, client } = await open(t, {});
  assert.deepEqual(await client.callTool('tool_1', { standIn: { callLine: 'not-json' } }, { timeoutMs: 10000 }), {
    rpcError: { code: -32700, message: 'the MCP server sent a line that is not JSON' },
  });
  await waitFor(() => cancelsOf(server).length === 1, 'the call to be cancelled');
  assert.equal((await client.callTool('tool_2', {}, { timeoutMs: 10000 })).truncated, false);
});

test('calls run one at a time, a ping does not wait for them, and a call whose limit passes in the queue is never sent', async (t) => {
  const { server, client } = await open(t, { slowCallMs: 400 });
  const first = client.callTool('tool_1', {}, { timeoutMs: 10000 });
  const second = client.callTool('tool_2', {}, { timeoutMs: 10000 });
  const late = client.callTool('tool_3', {}, { timeoutMs: 50 });
  const stopped = new AbortController();
  const dropped = client.callTool('tool_3', {}, { timeoutMs: 10000, signal: stopped.signal });
  stopped.abort();
  assert.equal(await client.ping(), true);
  assert.equal(callsOf(server).length, 1);
  assert.deepEqual(await late, { timedOut: true });
  assert.deepEqual(await dropped, { timedOut: true });
  assert.equal((await first).result.content[0].text, 'called tool_1 with {}');
  assert.equal((await second).result.content[0].text, 'called tool_2 with {}');
  const lines = server.lines();
  const at = (find) => lines.findIndex(find);
  const [one, two] = callsOf(server);
  assert.ok(at((entry) => entry.answered === one.id) < at((entry) => entry.got?.id === two.id));
  assert.deepEqual(callsOf(server).map((message) => message.params.name), ['tool_1', 'tool_2']);
  assert.deepEqual(cancelsOf(server), []);
});

test('at the time limit the call ends as timed out and notifications/cancelled names it', async (t) => {
  const { server, client } = await open(t, { slowCallMs: 60000 });
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 200 }), { timedOut: true });
  const [call] = callsOf(server);
  const cancel = await waitFor(() => cancelsOf(server)[0], 'the cancel');
  assert.deepEqual(cancel, {
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call.id, reason: 'ksproxy stopped waiting for the answer' },
  });
});

test('the signal ends a call as timed out; a signal already aborted sends nothing', async (t) => {
  const { server, client } = await open(t, { slowCallMs: 60000 });
  const stop = new AbortController();
  const pending = client.callTool('tool_1', {}, { timeoutMs: 60000, signal: stop.signal });
  await waitFor(() => callsOf(server).length === 1, 'the call to arrive');
  stop.abort();
  assert.deepEqual(await pending, { timedOut: true });
  await waitFor(() => cancelsOf(server).length === 1, 'the cancel');
  assert.deepEqual(await client.callTool('tool_2', {}, { signal: AbortSignal.abort() }), { timedOut: true });
  assert.equal(await client.ping({ signal: AbortSignal.abort() }), false);
  await assert.rejects(client.listTools({ signal: AbortSignal.abort() }), /^Error: the wait for tools\/list was stopped$/);
  assert.equal(callsOf(server).length, 1);
  assert.equal(server.got().filter((message) => message.method === 'ping').length, 0);
});

test('a ping answered with an error still shows the server is there', async (t) => {
  const { client } = await open(t, { pingError: true });
  assert.equal(await client.ping({ signal: AbortSignal.timeout(10000) }), true);
});

test('limitMs ends a slow start and stops the program, which was still running', async () => {
  const server = standIn({ slowStartMs: 60000 });
  await assert.rejects(connectStdio({
    argv: server.argv, env: ENV, cwd: server.dir, limitMs: 3000,
  }), /^Error: the MCP server was not ready within 3 seconds$/);
  // The limit leaves the stand-in time to start and write its pid, also on a busy machine.
  const pid = server.pid();
  assert.ok(pid !== undefined);
  await waitFor(() => !alive(pid), 'the stand-in to be stopped');
});

test('the signal ends the wait at start; a signal already aborted starts nothing', async () => {
  const server = standIn({ slowStartMs: 60000 });
  const stop = new AbortController();
  const starting = connectStdio({
    argv: server.argv, env: ENV, cwd: server.dir, signal: stop.signal,
  });
  await waitFor(() => server.pid() !== undefined, 'the stand-in to start');
  assert.ok(alive(server.pid()));
  stop.abort();
  await assert.rejects(starting, /^Error: the start of the MCP server was stopped$/);
  await waitFor(() => !alive(server.pid()), 'the stand-in to be stopped');

  const never = standIn({});
  await assert.rejects(connectStdio({
    argv: never.argv, env: ENV, cwd: never.dir, signal: AbortSignal.abort(),
  }), /^Error: the start of the MCP server was stopped$/);
  assert.deepEqual(never.lines(), []);
});

test('a program that cannot be started gives a plain error', async () => {
  const dir = fs.realpathSync(tempDir('ks-mcpc-'));
  await assert.rejects(connectStdio({ argv: [path.join(dir, 'no-such-server')], env: ENV, cwd: dir }), /^Error: could not start the MCP server: spawn .*ENOENT$/);
  await assert.rejects(connectStdio({ argv: [process.execPath, STAND_IN], env: ENV, cwd: path.join(dir, 'gone') }), /^Error: could not start the MCP server: spawn .*ENOENT$/);
  await assert.rejects(connectStdio({ argv: ['bad\0name'], env: ENV, cwd: dir }), /^Error: could not start the MCP server: /);
});

test('a server that exits during the start fails it with its exit code', async () => {
  const server = standIn({ exitAt: 1, stderrText: 'missing JIRA_URL\n' });
  await assert.rejects(connectStdio({
    argv: server.argv, env: ENV, cwd: server.dir, limitMs: 20000,
  }), (err) => {
    // The error carries the last lines the program wrote to stderr, for the caller to show where it may.
    assert.match(err.message, /^the MCP server stopped \(exit 3\)$/);
    assert.deepEqual(err.stderrTail(5), ['missing JIRA_URL']);
    return true;
  });
});

test('a server that exits during a call ends it; later calls, pings and lists see the end; onEnd is told', async (t) => {
  const { client } = await open(t, { era: 'legacy', exitAt: 2 });
  const ends = [];
  client.onEnd((info) => ends.push(info));
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { ended: { code: 3, signal: null } });
  assert.deepEqual(ends, [{ code: 3, signal: null }]);
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { ended: { code: 3, signal: null } });
  assert.equal(await client.ping(), false);
  await assert.rejects(client.listTools(), /^Error: the MCP server stopped \(exit 3\)$/);
  const late = await new Promise((resolve) => {
    client.onEnd(resolve);
  });
  assert.deepEqual(late, { code: 3, signal: null });
  assert.deepEqual(await client.close(), { code: 3, signal: null });
});

test('a server that exits between calls is seen by onEnd and by the next call; a callback that throws harms nothing', async (t) => {
  const { client } = await open(t, { era: 'legacy', exitAfter: 2 });
  const ends = [];
  client.onEnd(() => {
    throw new Error('a callback that fails');
  });
  client.onEnd((info) => ends.push(info));
  assert.equal((await client.callTool('tool_1', {}, { timeoutMs: 10000 })).truncated, false);
  await waitFor(() => ends.length === 1, 'onEnd');
  assert.deepEqual(ends, [{ code: 3, signal: null }]);
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { ended: { code: 3, signal: null } });
});

test('a write right after the server exits, or to a server that closed its stdin, never throws', async (t) => {
  const { client } = await open(t, { era: 'legacy', exitAfter: 1 });
  const info = await new Promise((resolve) => {
    client.onEnd(resolve);
  });
  assert.deepEqual(info, { code: 3, signal: null });

  const { server, client: deaf } = await open(t, { deaf: true });
  assert.equal(deaf.era, LEGACY_VERSION);
  const killed = await new Promise((resolve) => {
    deaf.onEnd(resolve);
  });
  assert.deepEqual(killed, { code: null, signal: 'SIGKILL' });
  assert.ok(!alive(server.pid()));
  await assert.rejects(deaf.listTools(), /^Error: the MCP server stopped \(signal SIGKILL\)$/);
});

test('stderrTail gives the last lines of stderr without control characters, and nothing of stderr reaches an answer', async (t) => {
  const stderrText = `starting\n\u001b[31merror:\u001b[0m bad\ttoken ${FAKE_SECRET}\r\n\u001b]0;title\u0007bell\u0007 and ‮flip\n\n`;
  const { client } = await open(t, { stderrText });
  const lines = await waitFor(() => {
    const tail = client.stderrTail(2);
    return tail.length === 2 && tail[1].includes('flip') ? tail : null;
  }, 'the stderr lines');
  assert.deepEqual(lines, [`error: bad token ${FAKE_SECRET}`, 'bell and flip']);
  assert.deepEqual(client.stderrTail(0), []);
  assert.deepEqual(client.stderrTail(20), ['starting', ...lines]);
  const answer = await client.callTool('tool_1', {}, { timeoutMs: 10000 });
  assert.ok(!JSON.stringify(answer).includes(FAKE_SECRET));
});

test('stderr is kept in a 64 KiB ring: only the newest lines stay', async (t) => {
  const { client } = await open(t, { stderrText: `${'a'.repeat(99)}\n`, stderrRepeat: 1500 });
  // 1,500 lines of 100 bytes: the newest 65,536 bytes are the end of one line (35 bytes) and 655 whole lines.
  const tail = await waitFor(() => {
    const lines = client.stderrTail(2000);
    return lines.length === 656 && lines.at(-1).length === 99 ? lines : null;
  }, 'the stderr lines');
  assert.equal(tail[0], 'a'.repeat(35));
  assert.ok(tail.slice(1).every((line) => line === 'a'.repeat(99)));
});

test('close: a server that exits when stdin closes is not signalled', async (t) => {
  const { server, client } = await open(t, {});
  const closing = client.close();
  assert.equal(client.close(), closing);
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { ended: { code: 0, signal: null } });
  assert.deepEqual(await closing, { code: 0, signal: null });
  assert.ok(server.lines().some((entry) => entry.event === 'stdin-end'));
  assert.ok(!server.lines().some((entry) => entry.event === 'signal'));
});

test('close: a server that stays after stdin closes gets SIGTERM after 2 seconds', async (t) => {
  const { server, client } = await open(t, { onStdinEnd: 'stay' });
  const started = Date.now();
  assert.deepEqual(await client.close(), { code: null, signal: 'SIGTERM' });
  assert.ok(Date.now() - started >= 1900, `${Date.now() - started} ms`);
  assert.ok(server.lines().some((entry) => entry.event === 'signal'));
});

test('close: a server that ignores SIGTERM is killed 2 seconds later, with its process group; a call in flight ends', async (t) => {
  const { server, client } = await open(t, {
    onStdinEnd: 'stay', onTerm: 'ignore', child: true, slowCallMs: 60000,
  });
  const grandchild = await waitFor(() => server.lines().find((entry) => entry.event === 'child')?.pid, 'the child');
  const call = client.callTool('tool_1', {}, { timeoutMs: 60000 });
  await waitFor(() => callsOf(server).length === 1, 'the call to arrive');
  const started = Date.now();
  const closing = client.close();
  await waitFor(() => server.lines().some((entry) => entry.event === 'signal'), 'SIGTERM');
  assert.ok(alive(server.pid()), 'the stand-in is still running when it is killed');
  assert.deepEqual(await closing, { code: null, signal: 'SIGKILL' });
  assert.ok(Date.now() - started >= 3900, `${Date.now() - started} ms`);
  assert.deepEqual(await call, { ended: { code: null, signal: 'SIGKILL' } });
  await waitFor(() => !alive(grandchild), 'the child to be killed');
});

test('a program left in the group that keeps stdout open does not hold the end back', async (t) => {
  const { server, client } = await open(t, { child: true });
  const grandchild = await waitFor(() => server.lines().find((entry) => entry.event === 'child')?.pid, 'the child');
  assert.deepEqual(await client.close(), { code: 0, signal: null });
  await waitFor(() => !alive(grandchild), 'the child to be killed');
});

test('the program gets exactly the environment and the working folder it was given', async (t) => {
  const env = { PATH: process.env.PATH, ONLY_HERE: 'yes', JIRA_API_KEY_FOR_TEST: FAKE_SECRET };
  const { server } = await open(t, {}, { env });
  const start = server.lines().find((entry) => entry.event === 'start');
  assert.equal(start.cwd, server.dir);
  // Node itself passes NODE_V8_COVERAGE to a child while the tests measure coverage, and macOS may add
  // __CF_USER_TEXT_ENCODING; neither comes from ksproxy.
  const added = new Set(['NODE_V8_COVERAGE', '__CF_USER_TEXT_ENCODING']);
  const keys = Object.keys(start.env).filter((key) => !added.has(key)).sort();
  assert.deepEqual(keys, ['JIRA_API_KEY_FOR_TEST', 'ONLY_HERE', 'PATH']);
  assert.equal(start.env.JIRA_API_KEY_FOR_TEST, FAKE_SECRET);
});

test('listTools: each page counts as it was received, and the pages may take at most maxListBytes in all', async (t) => {
  // The review's server: endless pages of one tool of 8 MiB. Three pages pass the default of 16 MiB.
  const { client: fat } = await open(t, { era: 'legacy', fatPages: 8 * 1024 * 1024 });
  await assert.rejects(fat.listTools(), new Error(`the list of tools of the MCP server takes more than ${MAX_LIST_BYTES} bytes over all its pages`));
  const { server, client: small } = await open(t, { tools: 40, pageSize: 1 }, { maxListBytes: 2000 });
  await assert.rejects(small.listTools(), /^Error: the list of tools of the MCP server takes more than 2000 bytes over all its pages$/);
  const pages = server.got().filter((message) => message.method === 'tools/list').length;
  assert.ok(pages > 1 && pages < 40, `${pages} pages`);
  const { client: fits } = await open(t, { tools: 40, pageSize: 1 }, { maxListBytes: 20000 });
  assert.equal((await fits.listTools()).tools.length, 40);
});

test('a server that asks without reading its stdin cannot grow the backlog: answers wait for at most 1 MiB, calls still go', async (t) => {
  const resume = path.join(fs.realpathSync(tempDir('ks-mcpc-flood-')), 'resume');
  const { client } = await open(t, { era: 'legacy' });
  const count = 40000;
  assert.deepEqual(textOf(await client.callTool('tool_1', { standIn: { askFlood: count, resume } }, { timeoutMs: 60000 })), `asked ${count} times`);
  // The call above was answered after every request, so each request was read and answered or dropped by now.
  fs.writeFileSync(resume, '');
  const read = Number(/^read (\d+) answers$/.exec(textOf(await client.callTool('tool_1', { standIn: { countAnswers: true } }, { timeoutMs: 60000 })))[1]);
  const line = Buffer.byteLength(`${JSON.stringify({ jsonrpc: '2.0', id: 'flood', error: { code: -32601, message: 'ksproxy does not support requests from an MCP server' } })}\n`);
  // What waited on ksproxy's side (1 MiB), what the pipe and the stand-in's own buffer hold, and one more line.
  assert.ok(read > 0 && read * line <= 1024 * 1024 + 512 * 1024, `${read} answers of ${line} bytes`);
  assert.ok(read < count, 'answers were dropped');
});

test('a hidden text is hidden before the engine clips a server text: an error, serverInfo and the lines of stderr', async (t) => {
  const secret = 'S3cr3t\tmcp-engine-value-0451';
  const hidden = [secret];
  // The error text keeps 299 characters of the message: 5 of the secret would fall before that cut.
  const message = `${'x'.repeat(294)}${secret} and the rest`;
  const { client } = await open(t, {
    era: 'legacy', listAnswer: { error: { code: -32000, message } }, serverInfo: { name: `${'n'.repeat(60)}${secret}`, version: secret },
  }, { hidden });
  await assert.rejects(client.listTools(), new Error(`the MCP server refused tools/list: ${'x'.repeat(294)}[hidd…`));
  assert.deepEqual(client.serverInfo, { name: `${'n'.repeat(60)}[hi…`, version: '[hidden]' });
  // A secret that holds a tab is hidden before the tab becomes a space.
  const env = { ...ENV, TOKEN_OF_TEST: secret };
  const { client: noisy } = await open(t, { secretVar: 'TOKEN_OF_TEST', stderrText: 'token @SECRET@ seen\n' }, { env, hidden });
  assert.deepEqual(await waitFor(() => noisy.stderrTail(1).at(0), 'the stderr line'), 'token [hidden] seen');
});
