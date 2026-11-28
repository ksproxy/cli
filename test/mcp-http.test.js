import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  LEGACY_VERSION, MODERN_VERSION, connectHttp, reachReason,
} from '../src/kinds/engines/mcp-client.js';
import { ERROR_BODY, startHttpStandIn } from './fixtures/mcp-server.js';
import { selfSigned } from './fixtures/self-signed.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const SECRET = 'mcp-S3CR3T-http-4b1e-unmistakable';
const AUTH = `Bearer ${SECRET}`;
const ACCEPT = 'application/json, text/event-stream';
const END = { code: null, signal: null };
const CANCEL_REASON = 'ksproxy stopped waiting for the answer';

const auth = () => ({ authorization: AUTH });

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

async function serve(t, options) {
  const server = await startHttpStandIn(options);
  t.after(() => server.close());
  return server;
}

async function open(t, options = {}, extra = {}) {
  const server = await serve(t, options);
  const client = await connectHttp({
    url: server.url, headers: auth, limitMs: 10000, ...extra,
  });
  t.after(() => client.close());
  return { server, client };
}

// fetch, with every request it was given kept.
function recording() {
  const seen = [];
  return {
    seen,
    bodies: () => seen.filter((init) => typeof init.body === 'string').map((init) => JSON.parse(init.body)),
    fetchImpl: (url, init) => {
      seen.push(init);
      return fetch(url, init);
    },
  };
}

const posts = (server) => server.requests().filter((request) => request.method === 'POST');
const methodsOf = (server) => posts(server).map((request) => request.message.method ?? 'answer');
const callsOf = (server) => posts(server).filter((request) => request.message.method === 'tools/call');
const cancelsOf = (server) => posts(server).filter((request) => request.message.method === 'notifications/cancelled');
const closedEarly = (server, id) => server.log.some((entry) => entry.closedEarly === id);
const textOf = (answer) => answer.result.content[0].text;

test('modern, JSON: server/discover finds the era, and every request carries the token, the version and Mcp-Method', async (t) => {
  const { server, client } = await open(t, { serverInfo: { name: 'shop-tools', version: '2.0.0' } });
  assert.equal(client.era, MODERN_VERSION);
  assert.deepEqual(client.serverInfo, { name: 'shop-tools', version: '2.0.0' });
  assert.equal(client.stderrTail, undefined);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['tool_1', 'tool_2', 'tool_3']);
  assert.deepEqual(await client.callTool('tool_2', { key: 'SHOP-1' }, { timeoutMs: 10000, maxBytes: 1000 }), {
    result: { content: [{ type: 'text', text: 'called tool_2 with {"key":"SHOP-1"}' }], isError: false, resultType: 'complete' },
    truncated: false,
  });
  assert.equal(await client.ping(), true);
  assert.deepEqual(await client.close(), END);

  const requests = server.requests();
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'POST', 'POST', 'POST'], 'no DELETE without a session');
  assert.deepEqual(methodsOf(server), ['server/discover', 'tools/list', 'tools/call', 'ping']);
  for (const { headers, message, path } of requests) {
    assert.equal(path, '/mcp');
    assert.equal(headers.authorization, AUTH);
    assert.equal(headers.accept, ACCEPT);
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['mcp-protocol-version'], MODERN_VERSION);
    assert.equal(headers['mcp-method'], message.method);
    assert.equal(headers['mcp-session-id'], undefined);
    assert.equal(message.params._meta[VERSION_KEY], MODERN_VERSION);
  }
  assert.deepEqual(requests[0].message.params._meta, {
    [VERSION_KEY]: MODERN_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'ksproxy', version: PKG.version },
    'io.modelcontextprotocol/clientCapabilities': {},
  });
  assert.equal(requests[2].headers['mcp-name'], 'tool_2');
  assert.equal(requests[1].headers['mcp-name'], undefined);
  assert.deepEqual(requests.map((request) => request.message.id), [1, 2, 3, 4]);
});

test('modern, SSE: answers come in a stream among lines to drop, every page is read, and the stream ends at the answer', async (t) => {
  const { server, client } = await open(t, {
    sse: true, keepOpen: true, notify: true, tools: 5, pageSize: 2,
  });
  assert.equal(client.era, MODERN_VERSION);
  assert.equal((await client.listTools()).tools.length, 5);
  const answer = await client.callTool('tool_1', { key: 1 }, { timeoutMs: 10000 });
  assert.equal(textOf(answer), 'called tool_1 with {"key":1}');
  const [call] = callsOf(server);
  await waitFor(() => closedEarly(server, call.message.id), 'the client to close the stream after the answer');
  assert.deepEqual(cancelsOf(server), []);
});

test('legacy: each answer a session server gives to server/discover leads to initialize, then notifications/initialized', async (t) => {
  const cases = [
    { legacyAnswer: '400-session-required' }, { legacyAnswer: '404' }, { legacyAnswer: '405' },
    { legacyAnswer: 'method-not-found' }, { sessions: false },
  ];
  for (const options of cases) {
    const { server, client } = await open(t, { era: 'legacy', ...options });
    assert.equal(client.era, LEGACY_VERSION, JSON.stringify(options));
    assert.deepEqual(methodsOf(server), ['server/discover', 'initialize', 'notifications/initialized'], JSON.stringify(options));
    assert.equal((await client.callTool('tool_1', {}, { timeoutMs: 10000 })).truncated, false);
  }
});

test('legacy, JSON and SSE: the session id and the answered version go on every later message, and DELETE ends the session', async (t) => {
  for (const sse of [false, true]) {
    const { server, client } = await open(t, {
      era: 'legacy', version: '2025-06-18', sse, serverInfo: { name: 'jira', version: '0.24.8' },
    });
    assert.equal(client.era, '2025-06-18');
    assert.deepEqual(client.serverInfo, { name: 'jira', version: '0.24.8' });
    assert.equal((await client.listTools()).tools.length, 3);
    assert.equal(textOf(await client.callTool('tool_1', { key: 'a' }, { timeoutMs: 10000 })), 'called tool_1 with {"key":"a"}');
    assert.equal(await client.ping(), true);
    assert.deepEqual(await client.close(), END);
    const requests = server.requests();
    assert.deepEqual(requests.map((request) => request.message?.method ?? request.method), [
      'server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping', 'DELETE',
    ]);
    const [discover, initialize, ...later] = requests;
    assert.equal(discover.headers['mcp-protocol-version'], MODERN_VERSION);
    assert.equal(discover.headers['mcp-method'], 'server/discover');
    assert.equal(initialize.headers['mcp-protocol-version'], LEGACY_VERSION);
    assert.equal(initialize.headers['mcp-session-id'], undefined);
    assert.deepEqual(initialize.message.params, {
      protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'ksproxy', version: PKG.version },
    });
    for (const request of [initialize, ...later]) {
      assert.equal(request.headers.authorization, AUTH);
      assert.equal(request.headers['mcp-method'], undefined);
      assert.equal(request.headers['mcp-name'], undefined);
      assert.equal(request.message?.params?._meta, undefined);
    }
    for (const request of later) {
      assert.equal(request.headers['mcp-session-id'], 'session-1');
      assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
    }
    assert.equal(later[0].message.id, undefined);
  }
  const { server, client } = await open(t, { era: 'legacy', deleteAnswer: 405 });
  assert.deepEqual(await client.close(), END);
  assert.equal(server.requests().at(-1).method, 'DELETE');
});

test('a request from the server inside a stream is answered by POST: ping with an empty result, anything else -32601', async (t) => {
  const { server, client } = await open(t, { sse: true, pingClient: true });
  assert.equal(textOf(await client.callTool('tool_1', {}, { timeoutMs: 10000 })), 'called tool_1 with {}');
  const pong = await waitFor(() => posts(server).find((request) => request.message.id === 'ping-1'), 'the answer to ping');
  assert.deepEqual(pong.message, { jsonrpc: '2.0', id: 'ping-1', result: {} });
  assert.equal(pong.headers.authorization, AUTH);
  assert.equal(pong.headers['mcp-protocol-version'], MODERN_VERSION);
  assert.equal(pong.headers['mcp-method'], undefined);

  const { server: older, client: asked } = await open(t, { era: 'legacy', sse: true, askInput: 'sampling/createMessage' });
  const answer = await asked.callTool('tool_1', {}, { timeoutMs: 10000 });
  assert.deepEqual(answer.result.content, [{ type: 'text', text: 'answered after asking' }]);
  const refusal = posts(older).find((request) => request.message.id === 'ask-1');
  assert.deepEqual(refusal.message.error, { code: -32601, message: 'ksproxy does not support requests from an MCP server' });
  assert.equal(refusal.headers['mcp-session-id'], 'session-1');
  assert.equal(refusal.headers.authorization, AUTH);
  assert.deepEqual(cancelsOf(older), []);
});

test('a session that expires is renewed once and the request repeated once; a second 404 is an HTTP error', async (t) => {
  const { server, client } = await open(t, { era: 'legacy', expireAt: [1] });
  assert.equal((await client.listTools()).tools.length, 3);
  assert.deepEqual(methodsOf(server), [
    'server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/list',
  ]);
  const lists = posts(server).filter((request) => request.message.method === 'tools/list');
  assert.deepEqual(lists.map((request) => request.headers['mcp-session-id']), ['session-1', 'session-2']);
  assert.deepEqual(lists.map((request) => request.message.id), [3, 3], 'the same request is repeated');
  await client.close();
  assert.equal(server.requests().at(-1).headers['mcp-session-id'], 'session-2');

  const { server: twice, client: gone } = await open(t, { era: 'legacy', expireAt: [1, 2, 3, 4] });
  assert.deepEqual(await gone.callTool('tool_1', { standIn: { status: 503 } }, { timeoutMs: 10000 }), { httpError: { status: 503, retryAfter: null } });
  assert.deepEqual(await gone.callTool('tool_1', {}, { timeoutMs: 10000 }), { httpError: { status: 404, retryAfter: null } });
  await assert.rejects(gone.listTools(), /^Error: the MCP server answered tools\/list with HTTP 404$/);
  assert.equal(methodsOf(twice).filter((method) => method === 'initialize').length, 3);
});

test('one re-initialize at a time: requests that meet the same expired session share it; a late 404 only repeats', async (t) => {
  const { server, client } = await open(t, { era: 'legacy', expireAt: [1], slowRenewMs: 300 });
  const [listed, called] = await Promise.all([client.listTools(), client.callTool('tool_1', {}, { timeoutMs: 10000 })]);
  assert.equal(listed.tools.length, 3);
  assert.equal(textOf(called), 'called tool_1 with {}');
  assert.equal(methodsOf(server).filter((method) => method === 'initialize').length, 2);

  const { server: late, client: slow } = await open(t, { era: 'legacy', expireAt: [1] });
  const [first, second] = await Promise.all([
    slow.callTool('tool_1', { standIn: { delayMs: 400 } }, { timeoutMs: 10000 }),
    slow.callTool('tool_2', {}, { timeoutMs: 10000 }),
  ]);
  assert.equal(textOf(first), 'called tool_1 with {"standIn":{"delayMs":400}}');
  assert.equal(textOf(second), 'called tool_2 with {}');
  assert.equal(methodsOf(late).filter((method) => method === 'initialize').length, 2);
});

test('a renewal that fails leaves the 404 as the answer, and the next request renews again', async (t) => {
  const { server, client } = await open(t, { era: 'legacy', expireAt: [1] });
  server.options.initialize = 'refuse';
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { httpError: { status: 404, retryAfter: null } });
  delete server.options.initialize;
  assert.equal(textOf(await client.callTool('tool_1', {}, { timeoutMs: 10000 })), 'called tool_1 with {}');
  assert.equal(methodsOf(server).filter((method) => method === 'initialize').length, 3);
});

const MARKED = [
  {
    name: 'get_issue',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        count: { type: 'number', 'x-mcp-header': 'Count' },
        flag: { type: 'boolean', 'x-mcp-header': 'Flag' },
        key: { type: 'string' },
        odd: { type: 'string', 'x-mcp-header': 'Bad Name' },
      },
    },
  },
  { name: 'outil_é', inputSchema: { type: 'object' } },
  null,
  5,
  { name: 'no_schema' },
  { name: 'odd_schema', inputSchema: 5 },
  { name: 'odd_properties', inputSchema: { properties: 5 } },
  { name: 'odd_marks', inputSchema: { properties: { p: 5, q: { 'x-mcp-header': 5 }, constructor: { type: 'string' } } } },
];

test('modern: Mcp-Name and an Mcp-Param header for each argument marked x-mcp-header are built from the body', async (t) => {
  const { server, client } = await open(t, { tools: MARKED });
  assert.equal((await client.listTools()).tools.length, MARKED.length);
  const call = (args) => client.callTool('get_issue', args, { timeoutMs: 10000 });
  assert.equal(textOf(await call({
    region: 'eu-1', count: 3, flag: false, key: 'SHOP-1',
  })).startsWith('called get_issue'), true);
  assert.equal((await call({ key: 'SHOP-2', region: 'x'.repeat(1000), flag: true })).truncated, false);
  assert.equal((await call({ key: 'SHOP-3', region: '' })).truncated, false);
  assert.equal((await client.callTool('odd_marks', { p: 'é', constructor: 'x' }, { timeoutMs: 10000 })).truncated, false);
  assert.equal((await client.callTool('no_schema', { region: 'é' }, { timeoutMs: 10000 })).truncated, false);
  const [first, second] = callsOf(server);
  assert.equal(first.headers['mcp-name'], 'get_issue');
  assert.equal(first.headers['mcp-param-region'], 'eu-1');
  assert.equal(first.headers['mcp-param-count'], '3');
  assert.equal(first.headers['mcp-param-flag'], 'false');
  assert.equal(second.headers['mcp-param-count'], undefined);
  assert.equal(callsOf(server).length, 5);
});

test('modern: a value that cannot be sent in a header as it is fails closed, and nothing is sent', async (t) => {
  const { server, client } = await open(t, { tools: MARKED });
  await client.listTools();
  const refusals = [
    ['get_issue', { region: 'é' }, 'the argument region'],
    ['get_issue', { region: 'x'.repeat(1001) }, 'the argument region'],
    ['get_issue', { region: ' lead' }, 'the argument region'],
    ['get_issue', { region: 'trail ' }, 'the argument region'],
    ['get_issue', { region: 'a\nb' }, 'the argument region'],
    ['get_issue', { count: { n: 1 } }, 'the argument count'],
    ['get_issue', { flag: null }, 'the argument flag'],
    ['outil_é', {}, 'the tool name'],
  ];
  const sent = (name, args) => client.callTool(name, args, { timeoutMs: 10000 });
  for (const [name, args, what] of refusals) {
    assert.deepEqual(await sent(name, args), {
      rpcError: {
        code: -32602,
        message: `ksproxy cannot send this call: the MCP server wants ${what} in a header, and its value is not printable ASCII of at most 1000 characters without a space at either end`,
      },
    }, JSON.stringify(args));
  }
  // A header name that is not one is the server's fault, and the text says so, whatever the value.
  for (const [name, args, what] of [['get_issue', { key: 'k', odd: 'x' }, 'the argument odd'], ['odd_marks', { q: 'x' }, 'the argument q']]) {
    assert.deepEqual(await sent(name, args), {
      rpcError: {
        code: -32602,
        message: `ksproxy cannot send this call: the MCP server wants ${what} in a header, but the header name it gives is not 1 to 64 letters, digits, _ or -`,
      },
    }, JSON.stringify(args));
  }
  assert.deepEqual(callsOf(server), []);

  const { server: older, client: legacy } = await open(t, { era: 'legacy', tools: MARKED });
  await legacy.listTools();
  assert.equal((await legacy.callTool('get_issue', { region: 'é' }, { timeoutMs: 10000 })).truncated, false);
  assert.equal(callsOf(older)[0].headers['mcp-param-region'], undefined);
});

test('a redirect is never followed: a call gets it as an HTTP error, and a start fails', async (t) => {
  const { server, client } = await open(t, {});
  assert.deepEqual(await client.callTool('tool_1', { standIn: { status: 307 } }, { timeoutMs: 10000 }), {
    httpError: { status: 307, retryAfter: null },
  });
  const redirecting = await serve(t, { redirect: true });
  await assert.rejects(connectHttp({ url: redirecting.url, headers: auth }), (err) => {
    assert.equal(err.message, 'the MCP server answered initialize with a redirect (HTTP 307), which is not followed');
    return true;
  });
  for (const stand of [server, redirecting]) {
    assert.ok(stand.requests().every((request) => request.path === '/mcp'), 'nothing reached /elsewhere');
  }
});

test('an HTTP error gives the status and Retry-After in seconds, never its body', async (t) => {
  const { server, client } = await open(t, {});
  const statusOf = (standIn) => client.callTool('tool_1', { standIn }, { timeoutMs: 10000 });
  const answers = [
    await statusOf({ status: 429, retryAfter: '30' }),
    await statusOf({ status: 503, retryAfter: new Date(Date.now() + 60000).toUTCString() }),
    await statusOf({ status: 503, retryAfter: new Date(Date.now() - 60000).toUTCString() }),
    await statusOf({ status: 500, retryAfter: 'soon' }),
    await statusOf({ status: 401 }),
  ];
  assert.deepEqual(answers[0], { httpError: { status: 429, retryAfter: 30 } });
  assert.ok(answers[1].httpError.retryAfter >= 55 && answers[1].httpError.retryAfter <= 61, JSON.stringify(answers[1]));
  assert.deepEqual(answers[2], { httpError: { status: 503, retryAfter: 0 } });
  assert.deepEqual(answers[3], { httpError: { status: 500, retryAfter: null } });
  assert.deepEqual(answers[4], { httpError: { status: 401, retryAfter: null } });
  assert.ok(!JSON.stringify(answers).includes(ERROR_BODY));

  server.options.status = 500;
  await assert.rejects(client.listTools(), /^Error: the MCP server answered tools\/list with HTTP 500$/);
  const refusing = await serve(t, { status: 429, retryAfter: '30' });
  await assert.rejects(connectHttp({ url: refusing.url, headers: auth }), (err) => {
    assert.equal(err.message, 'the MCP server answered initialize with HTTP 429, retry after 30 seconds');
    assert.ok(!err.message.includes(ERROR_BODY));
    return true;
  });
});

test('an answer that ends without the answer: no body, a JSON answer to another id, an SSE stream closed or broken', async (t) => {
  const { server, client } = await open(t, {});
  for (const standIn of [{ status: 202 }, { status: 204 }, { wrongId: true }, { sse: true, closeEarly: true }, { sse: true, destroyEarly: true }]) {
    assert.deepEqual(await client.callTool('tool_1', { standIn }, { timeoutMs: 10000 }), { cutOff: true }, JSON.stringify(standIn));
  }
  assert.deepEqual(cancelsOf(server), []);
  server.options.sse = true;
  server.options.closeEarly = true;
  await assert.rejects(client.listTools(), /^Error: the answer of the MCP server to tools\/list ended early$/);

  const { server: older, client: legacy } = await open(t, { era: 'legacy' });
  assert.deepEqual(await legacy.callTool('tool_1', { standIn: { sse: true, closeEarly: true } }, { timeoutMs: 10000 }), { cutOff: true });
  const [call] = callsOf(older);
  const cancel = await waitFor(() => cancelsOf(older)[0], 'the cancel');
  assert.deepEqual(cancel.message, {
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call.message.id, reason: CANCEL_REASON },
  });
  assert.equal(cancel.headers['mcp-session-id'], 'session-1');
  assert.equal(cancel.headers.authorization, AUTH);
});

test('an answer that is not JSON: an HTML page, or SSE data that is not JSON', async (t) => {
  const { server, client } = await open(t, {});
  const notJson = { rpcError: { code: -32700, message: 'the MCP server sent a line that is not JSON' } };
  assert.deepEqual(await client.callTool('tool_1', { standIn: { html: true } }, { timeoutMs: 10000 }), notJson);
  assert.deepEqual(await client.callTool('tool_1', { standIn: { sse: true, callLine: 'not-json' } }, { timeoutMs: 10000 }), notJson);
  const [, streamed] = callsOf(server);
  await waitFor(() => closedEarly(server, streamed.message.id), 'the stream to be closed');
  const html = await serve(t, { html: true });
  await assert.rejects(connectHttp({ url: html.url }), /^Error: the MCP server sent a line that is not JSON in answer to server\/discover$/);

  const { server: older, client: legacy } = await open(t, { era: 'legacy' });
  assert.deepEqual(await legacy.callTool('tool_1', { standIn: { sse: true, callLine: 'not-json' } }, { timeoutMs: 10000 }), notJson);
  await waitFor(() => cancelsOf(older).length === 1, 'the cancel');
});

test('maxMessageBytes caps a JSON body, an SSE line and the data of one event; the stream is then closed', async (t) => {
  const limit = { maxMessageBytes: 200000 };
  const { server, client } = await open(t, {}, limit);
  const cases = [{ callLine: 'endless' }, { sse: true, callLine: 'endless' }, { sse: true, bigEvent: 300000 }];
  for (const standIn of cases) {
    assert.deepEqual(await client.callTool('tool_1', { standIn }, { timeoutMs: 20000 }), { tooLarge: true }, JSON.stringify(standIn));
  }
  // The endless answers are closed by the client; the stand-in ends the third one itself after its answer.
  for (const call of callsOf(server).slice(0, 2)) await waitFor(() => closedEarly(server, call.message.id), 'the answer to be closed');
  assert.deepEqual(cancelsOf(server), []);
  assert.equal(textOf(await client.callTool('tool_1', { standIn: { sse: true, bigEvent: 150000 } }, { timeoutMs: 20000 })), 'called tool_1 with {"standIn":{"sse":true,"bigEvent":150000}}');

  const { client: lists } = await open(t, { listAnswer: 'endless', sse: true }, limit);
  await assert.rejects(lists.listTools(), /^Error: the answer of the MCP server to tools\/list is larger than 200000 bytes$/);

  const { server: older, client: legacy } = await open(t, { era: 'legacy' }, limit);
  assert.deepEqual(await legacy.callTool('tool_1', { standIn: { sse: true, bigEvent: 300000 } }, { timeoutMs: 20000 }), { tooLarge: true });
  await waitFor(() => cancelsOf(older).length === 1, 'the cancel');
});

test('a hostile stream never holds a call or grows: a flood of notifications, a flood of requests, an endless trickle', async (t) => {
  const { server, client } = await open(t, { sse: true });
  assert.equal(textOf(await client.callTool('tool_1', { standIn: { flood: 20000 } }, { timeoutMs: 20000 })), 'called tool_1 with {"standIn":{"flood":20000}}');

  const fetches = recording();
  const { client: flooded } = await open(t, { sse: true, hang: ['answers'] }, { fetchImpl: fetches.fetchImpl });
  const answer = await flooded.callTool('tool_1', { standIn: { requests: 40 } }, { timeoutMs: 20000 });
  assert.equal(textOf(answer), 'called tool_1 with {"standIn":{"requests":40}}');
  const answered = fetches.bodies().filter((body) => String(body.id).startsWith('flood-'));
  assert.equal(answered.length, 8, 'at most 8 answers to the server are on their way at once');
  await flooded.close();

  const started = Date.now();
  assert.deepEqual(await client.callTool('tool_1', { standIn: { trickleMs: 20 } }, { timeoutMs: 300 }), { timedOut: true });
  assert.ok(Date.now() - started < 5000);
  const call = callsOf(server).at(-1);
  await waitFor(() => closedEarly(server, call.message.id), 'the stream to be closed');
  assert.deepEqual(cancelsOf(server), []);
});

test('at the time limit a modern stream is closed; an older call is also cancelled with notifications/cancelled', async (t) => {
  const { server, client } = await open(t, { slowCallMs: 60000 });
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 200 }), { timedOut: true });
  const [call] = callsOf(server);
  await waitFor(() => closedEarly(server, call.message.id), 'the request to be closed');
  assert.deepEqual(cancelsOf(server), []);

  for (const sse of [false, true]) {
    const { server: older, client: legacy } = await open(t, { era: 'legacy', slowCallMs: 60000, sse });
    const stop = new AbortController();
    const pending = legacy.callTool('tool_1', {}, { timeoutMs: 60000, signal: stop.signal });
    await waitFor(() => callsOf(older).length === 1, 'the call to arrive');
    stop.abort();
    assert.deepEqual(await pending, { timedOut: true });
    const cancel = await waitFor(() => cancelsOf(older)[0], 'the cancel');
    assert.equal(cancel.message.params.requestId, callsOf(older)[0].message.id);
    assert.equal(cancel.headers['mcp-session-id'], 'session-1');
    assert.equal(await legacy.ping({ signal: AbortSignal.abort() }), false);
    assert.deepEqual(await legacy.callTool('tool_2', {}, { signal: AbortSignal.abort() }), { timedOut: true });
    assert.equal(callsOf(older).length, 1);
    assert.equal((await legacy.listTools({ signal: AbortSignal.timeout(5000) })).tools.length, 3);
  }
});

test('calls run at the same time, and each answer is taken only from its own request with its own id', async (t) => {
  const { server, client } = await open(t, { slowCallMs: 300, sse: true });
  const first = client.callTool('tool_1', {}, { timeoutMs: 10000 });
  await waitFor(() => callsOf(server).length === 1, 'the first call to arrive');
  const second = client.callTool('tool_2', { standIn: { foreign: true } }, { timeoutMs: 10000 });
  await waitFor(() => callsOf(server).length === 2, 'the second call to arrive');
  const ids = callsOf(server).map((call) => call.message.id);
  assert.equal(server.log.some((entry) => ids.includes(entry.answered)), false, 'both calls are in flight together');
  assert.equal(textOf(await first), 'called tool_1 with {}');
  assert.equal(textOf(await second), 'called tool_2 with {"standIn":{"foreign":true}}');
});

test('the token from headers() goes on every request, ksproxy\'s own headers win, and no error text holds it', async (t) => {
  let asked = 0;
  const headers = () => {
    asked += 1;
    return { authorization: AUTH, accept: 'text/plain', 'mcp-protocol-version': '1999-01-01' };
  };
  const { server, client } = await open(t, { era: 'legacy', sse: true, pingClient: true }, { headers });
  const echoed = await client.callTool('tool_1', { standIn: { echoAuth: true } }, { timeoutMs: 10000 });
  assert.deepEqual(echoed, { rpcError: { code: -32001, message: 'the credential [hidden] is refused' } });
  assert.equal((await client.callTool('tool_1', {}, { timeoutMs: 10000 })).truncated, false);
  await waitFor(() => posts(server).some((request) => request.message.id === 'ping-1'), 'the answer to ping');
  await client.close();
  const requests = server.requests();
  assert.equal(asked, requests.length);
  for (const request of requests) {
    assert.equal(request.headers.authorization, AUTH);
    assert.notEqual(request.headers['mcp-protocol-version'], '1999-01-01');
  }
  for (const request of posts(server)) assert.equal(request.headers.accept, ACCEPT);

  const echoing = await serve(t, { echoAuth: true });
  await assert.rejects(connectHttp({ url: echoing.url, headers: () => ({ authorization: AUTH, 'x-tools': 'issues pull_requests' }) }), (err) => {
    assert.equal(err.message, 'the MCP server refused initialize: the credential [hidden] is refused');
    return true;
  });
  const plain = await serve(t, {});
  for (const broken of [() => ({ authorization: `Bearer ${SECRET}\nX` }), () => { throw new Error(`no ${SECRET}`); }]) {
    await assert.rejects(connectHttp({ url: plain.url, headers: broken }), (err) => {
      assert.equal(err.message, 'the MCP server could not be reached for server/discover');
      return true;
    });
  }
  assert.deepEqual(plain.requests(), []);
});

test('ping: true for a result, a JSON-RPC error or a 429; false for another HTTP error, no answer or a stopped wait', async (t) => {
  const { server, client } = await open(t, { pingError: true });
  assert.equal(await client.ping(), true);
  delete server.options.pingError;
  assert.equal(await client.ping(), true);
  server.options.status = 429;
  assert.equal(await client.ping(), true);
  server.options.status = 503;
  assert.equal(await client.ping(), false);
  delete server.options.status;
  server.options.hang = ['ping'];
  assert.equal(await client.ping({ signal: AbortSignal.timeout(200) }), false);
  await server.close();
  assert.equal(await client.ping(), false);
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { unreachable: true, reason: 'the connection was refused' });
  await assert.rejects(client.listTools(), /^Error: the MCP server could not be reached for tools\/list: the connection was refused$/);
});

test('the start: limitMs, the signal, a signal already aborted, a server out of reach, and failures of initialize', async (t) => {
  const hanging = await serve(t, { hang: ['server/discover'] });
  await assert.rejects(connectHttp({ url: hanging.url, limitMs: 300 }), /^Error: the MCP server did not answer within 0\.3 seconds$/);
  const stop = new AbortController();
  const starting = connectHttp({ url: hanging.url, signal: stop.signal });
  await waitFor(() => hanging.requests().length === 2, 'the request to arrive');
  stop.abort();
  await assert.rejects(starting, /^Error: the connection to the MCP server was stopped$/);
  const never = await serve(t, {});
  await assert.rejects(connectHttp({ url: never.url, signal: AbortSignal.abort() }), /^Error: the connection to the MCP server was stopped$/);
  assert.deepEqual(never.requests(), []);

  const closed = http.createServer();
  await new Promise((resolve) => {
    closed.listen(0, '127.0.0.1', resolve);
  });
  const { port } = closed.address();
  await new Promise((resolve) => {
    closed.close(resolve);
  });
  await assert.rejects(connectHttp({ url: `http://127.0.0.1:${port}/mcp` }), /^Error: the MCP server could not be reached for server\/discover: the connection was refused$/);

  const cases = [
    [{ era: 'legacy', initialize: 'no-version' }, 'the MCP server answered initialize without a protocol version'],
    [{ era: 'legacy', initialize: 'refuse' }, 'the MCP server refused initialize: Unsupported protocol version red'],
    [{ era: 'legacy', sessionId: 'a b' }, 'the MCP server sent a session id that is not visible ASCII'],
  ];
  for (const [options, expected] of cases) {
    const stand = await serve(t, options);
    await assert.rejects(connectHttp({ url: stand.url }), (err) => {
      assert.equal(err.message, expected);
      return true;
    });
  }

  const stuck = await serve(t, { era: 'legacy', hang: ['notifications/initialized'] });
  await assert.rejects(connectHttp({ url: stuck.url, headers: auth, limitMs: 300 }), /^Error: the MCP server did not answer within 0\.3 seconds$/);
  const ended = await waitFor(() => stuck.requests().find((request) => request.method === 'DELETE'), 'the DELETE');
  assert.equal(ended.headers['mcp-session-id'], 'session-1');
  assert.equal(ended.headers.authorization, AUTH);
});

test('close: a call in flight ends, onEnd is told, later requests see the end, and DELETE has a limit', async (t) => {
  const { server, client } = await open(t, { era: 'legacy', slowCallMs: 60000, hang: ['DELETE'] });
  const ends = [];
  client.onEnd(() => {
    throw new Error('a callback that fails');
  });
  client.onEnd((info) => ends.push(info));
  const call = client.callTool('tool_1', {}, { timeoutMs: 60000 });
  await waitFor(() => callsOf(server).length === 1, 'the call to arrive');
  const started = Date.now();
  const closing = client.close();
  assert.equal(client.close(), closing);
  assert.deepEqual(await call, { ended: END });
  assert.deepEqual(ends, [END]);
  assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { ended: END });
  assert.equal(await client.ping(), false);
  await assert.rejects(client.listTools(), /^Error: the connection to the MCP server was closed$/);
  const late = await new Promise((resolve) => {
    client.onEnd(resolve);
  });
  assert.deepEqual(late, END);
  assert.deepEqual(await closing, END);
  const waited = Date.now() - started;
  assert.ok(waited >= 1900 && waited < 6000, `${waited} ms`);
  assert.equal(server.requests().at(-1).method, 'DELETE');
  assert.deepEqual(cancelsOf(server), []);

  const { server: held, client: holding } = await open(t, { era: 'legacy', slowCallMs: 60000, hang: ['notifications/cancelled'] });
  assert.deepEqual(await holding.callTool('tool_1', {}, { timeoutMs: 200 }), { timedOut: true });
  await waitFor(() => cancelsOf(held).length === 1, 'the cancel to arrive');
  assert.deepEqual(await holding.close(), END);
});

// A fetch that answers every request itself: server/discover with a result, anything else with what answer gives.
function fakeFetch(answer) {
  return async (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === 'server/discover') {
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake', version: '1' } } });
    }
    return answer(message);
  };
}

const sse = (text) => new Response(text, { headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' } });
const answerLine = (id, text) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

test('SSE reading: CRLF, data without a space, data over several lines, comments and other fields', async () => {
  const fetchImpl = fakeFetch(({ id }) => {
    const line = answerLine(id, 'joined');
    const [head, tail] = [line.slice(0, line.indexOf(',') + 1), line.slice(line.indexOf(',') + 1)];
    return sse(`: a comment\r\nevent: message\r\nid: 7\r\nretry: 10\r\ndata:\r\n\r\ndata:   \r\n\r\ndata:${head}\r\ndata: ${tail}\r\n\r\n`);
  });
  const client = await connectHttp({ url: 'http://192.0.2.1/mcp', fetchImpl });
  assert.equal(client.serverInfo.name, 'fake');
  const answer = await client.callTool('tool_1', {}, { timeoutMs: 10000 });
  assert.equal(answer.result.content[0].text, 'joined');
  await client.close();
});

test('SSE reading: what follows the answer in the same chunk, even a line over the limit, is not read', async () => {
  const fetchImpl = fakeFetch(({ id }) => sse(`data: ${answerLine(id, 'first')}\n\ndata: ${answerLine(id, 'second')}\n\ndata: ${'x'.repeat(5000)}\n\n`));
  const client = await connectHttp({ url: 'http://192.0.2.1/mcp', fetchImpl, maxMessageBytes: 1000 });
  const answer = await client.callTool('tool_1', {}, { timeoutMs: 10000 });
  assert.equal(answer.result.content[0].text, 'first');
  await client.close();
});

test('listTools over HTTP: each body counts as it was received, and the pages may take at most maxListBytes in all', async (t) => {
  for (const sse of [false, true]) {
    // Pages of about 30,000 bytes: three fit in 100,000, the fourth passes it.
    const { server, client } = await open(t, { fatPages: 30000, sse }, { maxListBytes: 100000 });
    await assert.rejects(client.listTools(), /^Error: the list of tools of the MCP server takes more than 100000 bytes over all its pages$/);
    assert.equal(posts(server).filter((request) => request.message.method === 'tools/list').length, 4);
  }
  const { client } = await open(t, { tools: 40, pageSize: 1 }, { maxListBytes: 100000 });
  assert.equal((await client.listTools()).tools.length, 40);
});

test('a hidden text is hidden before the engine clips a server text over HTTP: a header refusal, serverInfo, an error', async (t) => {
  const hidden = [SECRET];
  const property = `${'p'.repeat(60)}${SECRET}`;
  const tools = [{ name: 'get_issue', inputSchema: { type: 'object', properties: { [property]: { type: 'string', 'x-mcp-header': 'Bad Name' } } } }];
  const { client } = await open(t, { tools, serverInfo: { name: `${'n'.repeat(60)}${SECRET}`, version: '1' } }, { hidden });
  await client.listTools();
  assert.deepEqual(await client.callTool('get_issue', { [property]: 'x' }, { timeoutMs: 10000 }), {
    rpcError: {
      code: -32602,
      message: `ksproxy cannot send this call: the MCP server wants the argument ${'p'.repeat(60)}[hi… in a header, but the header name it gives is not 1 to 64 letters, digits, _ or -`,
    },
  });
  assert.equal(client.serverInfo.name, `${'n'.repeat(60)}[hi…`);
  // The error text keeps 299 characters of the message: 5 of the secret would fall before that cut.
  const message = `${'x'.repeat(294)}${SECRET} and the rest`;
  const refusing = async (url, init) => Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -32000, message } });
  await assert.rejects(connectHttp({ url: 'http://127.0.0.1:9/mcp', fetchImpl: refusing, hidden }), new Error(`the MCP server refused initialize: ${'x'.repeat(294)}[hidd…`));
});

test('a server out of reach gives a reason from a fixed list, chosen by the code of the error only', async (t) => {
  const listening = (server) => new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const reasonOf = async (url) => {
    try {
      await connectHttp({ url });
    } catch (err) {
      return err.message;
    }
    return assert.fail('the connect should fail');
  };
  const START = 'the MCP server could not be reached for server/discover';

  // What Node 24 fetch really gives: a self-signed certificate, a closed port, a host name that does not exist, a
  // server that resets the connection and one that closes it without an answer.
  const { cert, key } = selfSigned('localhost');
  const tls = https.createServer({ cert, key }, (req, res) => res.end('x'));
  await listening(tls);
  t.after(() => tls.close());
  assert.equal(
    await reasonOf(`https://localhost:${tls.address().port}/mcp`),
    `${START}: the server's certificate is not trusted (set NODE_EXTRA_CA_CERTS for start to its CA)`,
  );

  const closed = http.createServer();
  await listening(closed);
  const { port } = closed.address();
  await new Promise((resolve) => {
    closed.close(resolve);
  });
  assert.equal(await reasonOf(`http://127.0.0.1:${port}/mcp`), `${START}: the connection was refused`);
  assert.equal(await reasonOf('http://nonexistent.invalid/mcp'), `${START}: the host name was not found`);

  const resetting = net.createServer((socket) => socket.destroy());
  await listening(resetting);
  t.after(() => resetting.close());
  assert.equal(await reasonOf(`http://127.0.0.1:${resetting.address().port}/mcp`), `${START}: the connection was closed by the other side`);
  const hanging = net.createServer((socket) => socket.once('data', () => socket.end()));
  await listening(hanging);
  t.after(() => hanging.close());
  assert.equal(await reasonOf(`http://127.0.0.1:${hanging.address().port}/mcp`), `${START}: the connection was closed by the other side`);

  // Every code of the list, on the cause of the error as fetch gives it or on the error itself. The message of the
  // error is never used: it holds a secret here, and a code that is not in the list gives no reason.
  const expected = {
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'trusted',
    SELF_SIGNED_CERT_IN_CHAIN: 'trusted',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'trusted',
    UNABLE_TO_GET_ISSUER_CERT: 'trusted',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'trusted',
    CERT_UNTRUSTED: 'trusted',
    CERT_HAS_EXPIRED: 'expired',
    CERT_NOT_YET_VALID: 'expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'another host name',
    HOSTNAME_MISMATCH: 'another host name',
    ECONNREFUSED: 'refused',
    ENOTFOUND: 'not found',
    EAI_AGAIN: 'not found',
    ETIMEDOUT: 'timed out',
    UND_ERR_CONNECT_TIMEOUT: 'timed out',
    ECONNRESET: 'closed by the other side',
    UND_ERR_SOCKET: 'closed by the other side',
  };
  for (const [code, word] of Object.entries(expected)) {
    for (const err of [Object.assign(new TypeError(SECRET), { cause: Object.assign(new Error(SECRET), { code }) }), Object.assign(new Error(SECRET), { code })]) {
      const reason = reachReason(err);
      assert.ok(reason.includes(word), `${code}: ${reason}`);
      assert.ok(!reason.includes(SECRET));
    }
  }
  assert.equal(reachReason(new TypeError(`fetch failed ${SECRET}`)), undefined);
  assert.equal(reachReason(Object.assign(new TypeError('x'), { cause: Object.assign(new Error('x'), { code: 'EPERM' }) })), undefined);
  assert.equal(reachReason(Object.assign(new TypeError('x'), { cause: 'ECONNREFUSED' })), undefined);
  assert.equal(reachReason(undefined), undefined);

  // The reason reaches the answer of a call that fails the same way, and the outcome stays as before without one.
  const stub = await serve(t, {});
  const failing = await connectHttp({ url: stub.url, fetchImpl: async (url, init) => (init.method === 'POST' && init.headers.get('mcp-method') === 'tools/call' ? Promise.reject(new TypeError(SECRET)) : fetch(url, init)) });
  assert.deepEqual(await failing.callTool('tool_1', {}, { timeoutMs: 10000 }), { unreachable: true });
  await failing.close();
});

test('a token that holds a space is hidden whole in a server error, at the start and in a call, not word by word', async () => {
  const { encodedForms } = await import('../src/kinds/engines/http.js');
  for (const token of ['ab12 SECRETWORDLONG', 'SECRETWORDLONG ab12', ' SECRETWORDLONG xy9']) {
    const said = `bad token: ${token} end, and SECRETWORDLONG alone`;
    const shown = 'bad token: [hidden] end, and [hidden] alone';
    const kindHidden = [token, ...encodedForms({ bearerEnv: 'T' }, { T: token })];
    for (const hidden of [[], kindHidden]) {
      const headers = () => ({ authorization: `Bearer ${token}` });
      const refusing = async (url, init) => Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -32000, message: said } });
      await assert.rejects(connectHttp({
        url: 'http://127.0.0.1:9/mcp', headers, fetchImpl: refusing, hidden,
      }), new Error(`the MCP server refused initialize: ${shown}`));
      const calling = async (url, init) => {
        if (typeof init.body !== 'string') return new Response(null, { status: 202 });
        const { id, method } = JSON.parse(init.body);
        if (method === 'server/discover') return Response.json({ jsonrpc: '2.0', id, result: { serverInfo: { name: 's', version: '1' } } });
        return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: said } });
      };
      const client = await connectHttp({
        url: 'http://127.0.0.1:9/mcp', headers, fetchImpl: calling, hidden,
      });
      assert.deepEqual(await client.callTool('tool_1', {}, { timeoutMs: 10000 }), { rpcError: { code: -32000, message: shown } });
      await client.close();
    }
  }
});
