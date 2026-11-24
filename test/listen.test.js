import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vault from './fixtures/kind-brokered.js';
import { selfSigned } from './fixtures/self-signed.js';
import { KINDS } from '../src/kinds/index.js';
import {
  LISTEN_LIMITS, allowedHosts, clientBook, clientName, listenPath, parseListen, startListener,
} from '../src/listen.js';
import { PROJECT_KEY, withProject } from '../src/paths.js';
import { processStartTime } from '../src/session.js';
import {
  newToken, revokeToken, tokenPath, tokenState,
} from '../src/token.js';
import {
  alive, cleanupAll, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

KINDS.push(vault);

const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const HEALTH_KEY = ['KSPROXY', 'HEALTH', 'MS'].join('_');
const SSH_LOG_KEY = ['KSPROXY', 'FAKE', 'SSH', 'LOG'].join('_');
const SSH_PID_KEY = ['KSPROXY', 'FAKE', 'SSH', 'PID', 'LOG'].join('_');
const VAULT_VAR = 'VAULT_SHOP_TOKEN';
const VAULT_VALUE = 'Qshop-S3CR3T-listen-test-value';

const LOOP = Object.freeze({ host: '127.0.0.1', port: 0, family: 4 });
const T0 = Date.parse('2026-11-22T10:00:00.000Z');
const PARSE_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };
const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-agent', version: '1.0' } },
};

const listeners = [];
const helpers = [];
after(async () => {
  for (const listener of listeners) await listener.close();
  for (const server of helpers) await new Promise((resolve) => { server.close(resolve); });
  cleanupAll();
});

// A root env with its own state and config folders, and no project.
function plainWorld() {
  const base = fs.realpathSync(tempDir('ks-listen-'));
  const env = { ...process.env, [STATE_KEY]: path.join(base, 'st'), [CONFIG_KEY]: path.join(base, 'cfg') };
  delete env[PROJECT_KEY];
  return { base, env, file: path.join(base, 'st', 'listen', 'listen.json') };
}

async function listen(env, options = {}) {
  const events = [];
  const listener = await startListener({
    addresses: [LOOP], tls: null, projects: new Map([[null, env]]), env, onEvent: (event) => events.push(event), ...options,
  });
  listeners.push(listener);
  const ports = listener.bound.map((text) => Number(text.slice(text.lastIndexOf(':') + 1)));
  return {
    listener, events, port: ports[0], ports,
  };
}

// One HTTP request with no connection reuse: the status, the headers and the body as text.
function send(port, {
  method = 'POST', target = '/mcp', headers = {}, body, setHost = true, tls,
} = {}) {
  return new Promise((resolve, reject) => {
    const lib = tls === undefined ? http : https;
    const req = lib.request({
      host: '127.0.0.1', port, method, path: target, headers, setHost, agent: false, ...tls,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const jsonHeaders = (token, extra = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });

function rpc(port, token, message, { target = '/mcp', headers = {}, tls } = {}) {
  return send(port, {
    target, headers: jsonHeaders(token, headers), body: JSON.stringify(message), tls,
  });
}

async function rpcResult(port, token, message, options) {
  const answer = await rpc(port, token, message, options);
  assert.equal(answer.status, 200, answer.body);
  return JSON.parse(answer.body);
}

// A raw connection: resolves once connected, and keeps what it receives; socket.closed tells when it closed.
function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.received = '';
    socket.on('data', (chunk) => { socket.received += chunk.toString('utf8'); });
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

// A connection that may be closed at once: it never rejects, it writes text once connected, and keeps what it receives.
function dropped(port, text) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.received = '';
  socket.on('data', (chunk) => { socket.received += chunk.toString('utf8'); });
  socket.on('error', () => {});
  socket.on('connect', () => socket.write(text));
  return socket;
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('parseListen accepts loopback and private addresses of this machine, and writes each in one form', () => {
  const interfaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4' }, { address: '::1', family: 'IPv6' }, { address: 'fe80::1', family: 'IPv6' }],
    en0: [
      { address: '192.168.1.20', family: 'IPv4' }, { address: '10.1.2.3', family: 'IPv4' }, { address: '172.16.5.4', family: 'IPv4' },
      { address: '172.31.255.254', family: 'IPv4' }, { address: '169.254.10.20', family: 'IPv4' }, { address: 'fd00::5', family: 'IPv6' },
      { address: 'fc12::7', family: 'IPv6' }, { address: 'fe80::abcd', family: 'IPv6' },
    ],
  };
  const accepted = [
    ['127.0.0.1:7443', '127.0.0.1', 7443, 4],
    ['[::1]:7443', '::1', 7443, 6],
    ['[0:0:0:0:0:0:0:1]:1', '::1', 1, 6],
    ['192.168.1.20:65535', '192.168.1.20', 65535, 4],
    ['10.1.2.3:7443', '10.1.2.3', 7443, 4],
    ['172.16.5.4:7443', '172.16.5.4', 7443, 4],
    ['172.31.255.254:7443', '172.31.255.254', 7443, 4],
    ['169.254.10.20:7443', '169.254.10.20', 7443, 4],
    ['[fd00::5]:7443', 'fd00::5', 7443, 6],
    ['[FD00:0::5]:7443', 'fd00::5', 7443, 6],
    ['[fc12::7]:7443', 'fc12::7', 7443, 6],
    ['[fe80::abcd%en0]:7443', 'fe80::abcd%en0', 7443, 6],
    ['[fe80::1%lo0]:7443', 'fe80::1%lo0', 7443, 6],
  ];
  for (const [text, host, port, family] of accepted) assert.deepEqual(parseListen(text, interfaces), { host, port, family }, text);
  // Without a list of interfaces, the ones of this machine are used: 127.0.0.1 is on every machine.
  assert.deepEqual(parseListen('127.0.0.1:7443'), { host: '127.0.0.1', port: 7443, family: 4 });

  const form = '--listen: write HOST:PORT, such as 192.168.1.20:7443, or [fd00::5]:7443 for IPv6';
  const port = '--listen: PORT must be a number from 1 to 65535';
  const name = '--listen: HOST must be an IP address, IPv6 in brackets; a name is not accepted';
  const zone = '--listen: only a link-local IPv6 address takes an interface after %, such as [fe80::1%en0]:7443';
  const needsZone = '--listen: a link-local IPv6 address needs its interface after %, such as [fe80::1%en0]:7443';
  const notOwn = (host) => `--listen: ${host} is not a loopback or private address of this machine`;
  const refused = [
    ['', form], ['127.0.0.1', form], ['127.0.0.1:', form], [':7443', form], ['fd00::5:7443', form], ['[fd00::5]', form],
    ['[fd00::5]7443', form], ['127.0.0.1:74 43', form], ['[::1]:7443x', form], ['a:b:7443', form], [' 127.0.0.1:7443', name],
    [5, form], [undefined, form],
    ['127.0.0.1:0', port], ['127.0.0.1:65536', port], ['127.0.0.1:07443', port], ['127.0.0.1:123456', port],
    ['localhost:7443', name], ['web1.example.com:7443', name], ['[web1]:7443', name], ['127.1:7443', name],
    ['01.2.3.4:7443', name], ['[%en0]:7443', name],
    ['[fd00::5%en0]:7443', zone], ['[::1%lo0]:7443', zone],
    ['[fe80::abcd]:7443', needsZone],
    ['0.0.0.0:7443', notOwn('0.0.0.0')], ['[::]:7443', notOwn('[::]')], ['192.0.2.10:7443', notOwn('192.0.2.10')],
    ['[2001:db8::10]:7443', notOwn('[2001:db8::10]')], ['172.32.0.1:7443', notOwn('172.32.0.1')],
    ['172.15.255.255:7443', notOwn('172.15.255.255')], ['8.8.8.8:7443', notOwn('8.8.8.8')],
    ['192.168.1.99:7443', notOwn('192.168.1.99')], ['127.0.0.2:7443', notOwn('127.0.0.2')], ['[fd00::6]:7443', notOwn('[fd00::6]')],
    ['[fe80::abcd%en1]:7443', notOwn('[fe80::abcd%en1]')], ['[fe80::abcd%lo0]:7443', notOwn('[fe80::abcd%lo0]')],
    ['[fe80::abcd%]:7443', notOwn('[fe80::abcd%]')], ['[::ffff:127.0.0.1]:7443', notOwn('[::ffff:127.0.0.1]')],
  ];
  // The public addresses are on the machine, so only their range refuses them.
  const withPublic = {
    ...interfaces,
    en1: ['192.0.2.10', '172.32.0.1', '172.15.255.255', '8.8.8.8', '0.0.0.0'].map((address) => ({ address, family: 'IPv4' }))
      .concat([{ address: '2001:db8::10', family: 'IPv6' }, { address: '::', family: 'IPv6' }]),
  };
  for (const [text, message] of refused) assert.throws(() => parseListen(text, withPublic), { message }, String(text));
});

test('allowedHosts: the address with its port, IPv6 in brackets without a zone, and localhost for a loopback address', () => {
  assert.deepEqual(allowedHosts({ host: '127.0.0.1', family: 4 }, 7443), ['127.0.0.1:7443', 'localhost:7443']);
  assert.deepEqual(allowedHosts({ host: '192.168.1.20', family: 4 }, 7443), ['192.168.1.20:7443']);
  assert.deepEqual(allowedHosts({ host: '::1', family: 6 }, 7443), ['[::1]:7443', 'localhost:7443']);
  assert.deepEqual(allowedHosts({ host: '0:0:0:0:0:0:0:1', family: 6 }, 1), ['[::1]:1', 'localhost:1']);
  assert.deepEqual(allowedHosts({ host: 'fe80::1%en0', family: 6 }, 7443), ['[fe80::1]:7443']);
  assert.deepEqual(allowedHosts({ host: 'fd00::5', family: 6 }, 80), ['[fd00::5]:80']);
});

test('clientName: name and version, printable ASCII only, at most 64 characters, else unknown', () => {
  assert.equal(clientName({ name: 'claude-code', version: '2.1' }), 'claude-code 2.1');
  assert.equal(clientName({ name: 'claude-code' }), 'claude-code');
  assert.equal(clientName({ version: '2.1' }), '2.1');
  assert.equal(clientName({ name: 'café\u001b[31m\n', version: 7 }), 'caf[31m');
  assert.equal(clientName({ name: 'x'.repeat(70), version: '1' }), 'x'.repeat(64));
  assert.equal(clientName({ name: `${'y'.repeat(63)}`, version: '1' }), 'y'.repeat(63));
  assert.equal(clientName({ name: '  spaced  ', version: '' }), 'spaced');
  for (const info of [undefined, null, 'agent', ['a', 'b'], {}, { name: 5 }, { name: 'éé' }, { name: '   ' }]) {
    assert.equal(clientName(info), 'unknown', JSON.stringify(info));
  }
});

test('clientBook: open connections, wrong tokens, the block, the refused events, names, calls and the record limit', () => {
  const events = [];
  let changes = 0;
  const book = clientBook({ limits: { ...LISTEN_LIMITS, maxClients: 2 }, onEvent: (event) => events.push(event), changed: () => { changes += 1; } });
  const t = (ms) => new Date(T0 + ms);
  const a = '192.0.2.1';
  const b = '192.0.2.2';

  book.opened(a);
  book.opened(a);
  book.closed(a);
  assert.deepEqual(book.list(), [], 'an open connection alone makes no record');
  assert.equal(changes, 3);

  for (let i = 0; i < 9; i += 1) book.wrong(a, t(i * 1000));
  assert.equal(book.blockedMs(a, t(8000)), 0, 'nine wrong tokens in a minute do not block');
  assert.deepEqual(events, [{ type: 'refused', from: a, count: 1 }], 'the first at once, the next ones wait for the report');
  book.wrong(a, t(9000));
  assert.equal(book.blockedMs(a, t(9000)), 60000, 'the tenth blocks for one minute');
  assert.equal(book.blockedMs(a, t(68999)), 1);
  assert.equal(book.blockedMs(a, t(69000)), 0);
  assert.equal(book.blockedMs(b, t(9000)), 0, 'an address with no record is not blocked');
  book.wrong(a, t(69000));
  assert.equal(book.blockedMs(a, t(69000)), 0, 'the count starts again after a block');
  assert.equal(events.length, 1);
  book.report();
  assert.deepEqual(events.slice(1), [{ type: 'refused', from: a, count: 10 }], 'the report counts every wrong token since the last event');
  assert.deepEqual(book.list(), [{
    from: a, client: 'unknown', firstSeen: t(0).toISOString(), lastCall: null, calls: 0, projects: [], open: 1, wrong: 11,
  }]);

  // Wrong tokens spread over more than a minute never block.
  for (let i = 0; i < 12; i += 1) book.wrong(b, t(i * 7000));
  assert.equal(book.blockedMs(b, t(77000)), 0);

  events.length = 0;
  book.named(b, 'agent 1', t(80000));
  assert.equal(book.called(b, 'shop', t(81000)), 'agent 1');
  assert.equal(book.called(b, 'ops', t(82000)), 'agent 1');
  assert.equal(book.called(b, 'shop', t(83000)), 'agent 1');
  assert.deepEqual(events, [{
    type: 'connected', from: b, client: 'agent 1', project: 'shop',
  }], 'connected once per address');
  assert.deepEqual(book.list()[1], {
    from: b, client: 'agent 1', firstSeen: t(0).toISOString(), lastCall: t(83000).toISOString(), calls: 3, projects: ['shop', 'ops'], open: 0, wrong: 12,
  });

  // A third address drops the record seen first with no open connection and no block: b, since a has a connection.
  assert.equal(book.called('192.0.2.3', 'default', t(90000)), 'unknown');
  assert.deepEqual(book.list().map((r) => r.from), [a, '192.0.2.3']);
  book.closed(a);
  assert.deepEqual(book.list().map((r) => r.open), [0, 0]);
});

test('every row of the HTTP table, in the order of the table', async () => {
  const { env, file } = plainWorld();
  const token = newToken(env);
  const { port, listener } = await listen(env, { limits: { maxBody: 200 } });
  const host = `127.0.0.1:${port}`;
  const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  const expect = async (request, status, body, headers = {}) => {
    const answer = await send(port, request);
    assert.equal(answer.status, status, `${JSON.stringify(request)}: ${answer.body}`);
    if (body !== undefined) assert.equal(answer.body, body);
    for (const [name, value] of Object.entries(headers)) assert.equal(answer.headers[name], value, name);
    return answer;
  };
  const good = (extra = {}) => ({ headers: jsonHeaders(token), body: JSON.stringify(PING), ...extra });
  const pong = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });

  // The path and the project first: any method, any header.
  for (const target of ['/nope', '/mcp/', '/mcpx', '/p//mcp', '/p/shop/mcp', '/p/a/b/mcp', '/P/default/mcp', 'http://x/mcp']) {
    await expect({ ...good(), target, headers: { origin: 'http://web1.example.com', host: 'evil.example' } }, 404, 'not served here', { connection: 'close' });
  }
  await expect({ method: 'GET', target: '/nope' }, 404, 'not served here');
  // The method.
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    await expect({ method, headers: { origin: 'http://web1.example.com' } }, 405, 'only POST is served here', { allow: 'POST' });
  }
  // An Origin header, before the Host and the token.
  await expect({ ...good(), headers: { ...jsonHeaders(wrong), origin: 'http://web1.example.com', host: 'evil.example' } }, 403, 'a request with an Origin header is refused');
  await expect({ ...good(), headers: { ...jsonHeaders(token), origin: 'null' } }, 403);
  // The Host header, before the token.
  for (const value of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `127.0.0.1:0${port}`,
    `[::1]:${port}`, `[zz]:${port}`, `127.0.0.1:${port}:1`, `[::1]`, `${host}.`]) {
    await expect({ ...good(), headers: { ...jsonHeaders(wrong), host: value } }, 421, 'the Host header does not name this listener');
  }
  await expect({ ...good(), setHost: false }, 421);
  for (const value of [host, `localhost:${port}`, `LOCALHOST:${port}`]) await expect({ ...good(), headers: { ...jsonHeaders(token), host: value } }, 200, pong);
  // The token: missing or not Bearer, wrong.
  const missing = 'the request has no token';
  for (const authorization of [undefined, '', 'Bearer', 'Bearer ', `Basic ${token}`, `${token}`, `Bearer ${token} x`]) {
    const headers = { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) };
    await expect({ ...good(), headers }, 401, missing, { 'www-authenticate': 'Bearer' });
  }
  await expect({ ...good(), headers: jsonHeaders(wrong) }, 401, 'the token is wrong', { 'www-authenticate': 'Bearer', connection: 'close' });
  await expect({ ...good(), headers: jsonHeaders('ksp_short') }, 401, 'the token is wrong');
  await expect({ ...good(), headers: { ...jsonHeaders(token), authorization: `bearer   ${token}` } }, 200, pong);
  // The content type, after the token.
  for (const type of ['text/plain', 'application/jsonx', 'application/json-rpc', undefined]) {
    const headers = { authorization: `Bearer ${token}`, ...(type === undefined ? {} : { 'content-type': type }) };
    await expect({ ...good(), headers }, 415, 'the body must be application/json');
  }
  await expect({ ...good(), headers: { ...jsonHeaders(wrong), 'content-type': 'text/plain' } }, 401);
  for (const type of ['application/json; charset=utf-8', 'Application/JSON', ' application/json ;x=1']) {
    await expect({ ...good(), headers: { ...jsonHeaders(token), 'content-type': type } }, 200, pong);
  }
  // The body size: by its Content-Length at once, or while it is read when it is sent in chunks.
  const over = JSON.stringify({ ...PING, pad: 'x'.repeat(200) });
  const exact = JSON.stringify({ ...PING, pad: 'x'.repeat(200 - JSON.stringify({ ...PING, pad: '' }).length) });
  assert.equal(exact.length, 200);
  await expect({ ...good(), body: over }, 413, 'the body is over 200 bytes', { connection: 'close' });
  await expect({ ...good(), headers: { ...jsonHeaders(wrong), 'content-length': '100000' }, body: over }, 401);
  await expect({ ...good(), headers: { ...jsonHeaders(token), 'transfer-encoding': 'chunked' }, body: over }, 413, 'the body is over 200 bytes');
  await expect({ ...good(), body: exact }, 200, pong);
  await expect({ ...good(), headers: { ...jsonHeaders(token), 'transfer-encoding': 'chunked' }, body: exact }, 200, pong);
  // The message: not JSON, not one JSON-RPC message, a notification, a response from the client, a request.
  for (const body of ['', 'not json', '{"jsonrpc":', 'ÿ']) {
    await expect({ ...good(), body }, 400, JSON.stringify(PARSE_ERROR), { 'content-type': 'application/json' });
  }
  const invalid = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  for (const body of ['[]', JSON.stringify([PING]), '5', 'null', JSON.stringify({ jsonrpc: '1.0', method: 'ping' }), JSON.stringify({ ...PING, id: {} })]) {
    await expect({ ...good(), body }, 400, invalid);
  }
  const notice = await expect({ ...good(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }, 202, '');
  assert.equal(notice.headers['content-type'], undefined);
  await expect({ ...good(), body: JSON.stringify({ jsonrpc: '2.0', id: 4, result: {} }) }, 202, '');
  await expect({ ...good(), body: JSON.stringify({ jsonrpc: '1.0', id: 5, method: 'ping' }) }, 200, JSON.stringify({ jsonrpc: '2.0', id: 5, error: { code: -32600, message: 'Invalid Request' } }));
  await expect({ ...good(), body: JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'nope' }) }, 200, JSON.stringify({ jsonrpc: '2.0', id: 'a', error: { code: -32601, message: 'Method not found: nope' } }));
  await expect({ ...good(), target: '/mcp?x=1' }, 200, pong, { 'content-type': 'application/json' });
  await expect({ ...good(), target: '/p/default/mcp' }, 200, pong);

  // A good request noted the use of the token: the address and the time.
  assert.equal(tokenState(env).record.lastAddress, '127.0.0.1');
  // Only the wrong tokens count, never the token or a body in a file of the listener.
  await listener.close();
  assert.equal(fs.existsSync(file), false);
  for (const name of fs.readdirSync(path.dirname(file))) {
    const text = fs.readFileSync(path.join(path.dirname(file), name), 'utf8');
    assert.ok(!text.includes(token) && !text.includes(wrong) && !text.includes('pad'), name);
  }
});

test('a wrong token counts toward the block of the address; a blocked address gets 429 even with the right token', async () => {
  const { env } = plainWorld();
  let clock = T0;
  const token = newToken(env, new Date(T0));
  const { port, events, listener } = await listen(env, { now: () => new Date(clock) });
  const wrong = 'ksp_not-the-token';
  const status = async (headers) => (await send(port, { headers, body: JSON.stringify(PING) })).status;

  // A missing token never counts.
  for (let i = 0; i < 12; i += 1) assert.equal(await status({ 'content-type': 'application/json' }), 401);
  assert.equal(await status(jsonHeaders(token)), 200);
  for (let i = 0; i < 9; i += 1) {
    clock += 1000;
    assert.equal(await status(jsonHeaders(wrong)), 401);
  }
  assert.equal(await status(jsonHeaders(token)), 200, 'nine wrong tokens do not block');
  clock += 1000;
  assert.equal(await status(jsonHeaders(wrong)), 401, 'the tenth wrong token is still read');
  const blocked = await send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body, 'too many wrong tokens from this address; try again later');
  assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(blocked.headers['www-authenticate'], undefined);
  // The path, the method, the Origin and the Host come before the block.
  assert.equal((await send(port, { target: '/nope', headers: jsonHeaders(token) })).status, 404);
  assert.equal((await send(port, { method: 'GET', headers: jsonHeaders(token) })).status, 405);
  assert.equal(await status({ ...jsonHeaders(token), origin: 'http://web1.example.com' }), 403);
  assert.equal(await status({ ...jsonHeaders(token), host: 'evil.example' }), 421);
  clock += 59999;
  const late = await send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) });
  assert.deepEqual([late.status, late.headers['retry-after']], [429, '1']);
  clock += 1;
  assert.equal(await status(jsonHeaders(token)), 200, 'the block ends after one minute');
  const refused = () => events.filter((e) => e.type === 'refused');
  clock += 1000;
  assert.equal(await status(jsonHeaders(wrong)), 401);
  assert.deepEqual(refused(), [{ type: 'refused', from: '127.0.0.1', count: 1 }], 'the first at once; the others wait for the report timer');
  assert.deepEqual(events[0], {
    type: 'connected', from: '127.0.0.1', client: 'unknown', project: 'default',
  });
  const [record] = listener.clients();
  assert.deepEqual([record.from, record.wrong, record.calls], ['127.0.0.1', 11, 3]);
});

test('a revoked, expired or unreadable token, or none, is refused at the next request and never counts toward the block', async () => {
  const { env } = plainWorld();
  const { port, events, listener } = await listen(env);
  const refusal = async (token, body) => {
    const answer = await send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) });
    assert.deepEqual([answer.status, answer.body, answer.headers['www-authenticate']], [401, body, 'Bearer']);
  };
  for (let i = 0; i < 11; i += 1) await refusal('ksp_any', 'the token file cannot be read');
  const token = newToken(env);
  assert.equal((await send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) })).status, 200);
  assert.equal(revokeToken(env), 'revoked');
  for (let i = 0; i < 11; i += 1) await refusal(token, 'the token was revoked');
  const old = newToken(env, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000));
  for (let i = 0; i < 11; i += 1) await refusal(old, 'the token expired');
  fs.writeFileSync(tokenPath(env), 'not json');
  for (let i = 0; i < 11; i += 1) await refusal(old, 'the token file cannot be read');
  const fresh = newToken(env);
  assert.equal((await send(port, { headers: jsonHeaders(fresh), body: JSON.stringify(PING) })).status, 200, 'nothing was blocked');
  assert.deepEqual(events.map((e) => e.type), ['connected']);
  assert.equal(listener.clients()[0].wrong, 0);
});

test('the client record, the connected event and listen.json: its contents, its mode, its updates and its removal', async () => {
  const { env, file } = plainWorld();
  const token = newToken(env);
  const before = Date.now();
  const { port, events, listener } = await listen(env, { limits: { listenWriteMs: 20 } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(listenPath(env), file);
  assert.deepEqual(readJson(file), {
    version: 1, pid: process.pid, processStartedAt: processStartTime(process.pid), addresses: [`127.0.0.1:${port}`], tls: false, clients: [],
  });
  assert.deepEqual(listener.bound, [`127.0.0.1:${port}`]);

  const init = await rpcResult(port, token, INIT);
  assert.equal(init.result.serverInfo.name, 'ksproxy');
  await rpcResult(port, token, PING);
  await rpcResult(port, token, { ...INIT, params: { clientInfo: { name: 'second', version: '2' } } }, { target: '/p/default/mcp' });
  assert.deepEqual(events, [{
    type: 'connected', from: '127.0.0.1', client: 'test-agent 1.0', project: 'default',
  }]);
  await waitFor(() => listener.clients()[0].open === 0, 10000, 'the connections to close');
  const [record] = listener.clients();
  assert.deepEqual({ ...record, firstSeen: 'T', lastCall: 'T' }, {
    from: '127.0.0.1', client: 'second 2', firstSeen: 'T', lastCall: 'T', calls: 3, projects: ['default'], open: 0, wrong: 0,
  });
  assert.ok(Date.parse(record.firstSeen) >= before - 1000 && Date.parse(record.lastCall) >= Date.parse(record.firstSeen));
  await waitFor(() => readJson(file).clients[0]?.calls === 3 && readJson(file).clients[0].open === 0, 10000, 'listen.json to show the calls');
  assert.deepEqual(readJson(file).clients, listener.clients());

  // A second listener with the same state folder is refused while this one lives; nothing of the first changes.
  const kept = fs.readFileSync(file, 'utf8');
  await assert.rejects(startListener({
    addresses: [{ host: '127.0.0.1', port, family: 4 }], tls: null, projects: new Map(), env, onEvent: () => {},
  }), { message: `another ksproxy start is listening (pid ${process.pid})` });
  assert.equal(fs.readFileSync(file, 'utf8'), kept);

  await listener.close();
  assert.equal(fs.existsSync(file), false);
  await listener.close();
  await assert.rejects(send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) }), { code: 'ECONNREFUSED' });
  assert.equal(listener.clients()[0].calls, 3);
});

test('a listen.json of a dead pid, of a reused pid, or one that cannot be read, is replaced', async () => {
  const { env, file } = plainWorld();
  const started = processStartTime(process.pid);
  for (const text of [
    JSON.stringify({ version: 1, pid: deadPid(), addresses: [], clients: [] }),
    JSON.stringify({ version: 1, pid: process.pid, processStartedAt: started - 3600000, addresses: [], clients: [] }),
    'not json',
    'null',
    JSON.stringify({ version: 1, pid: 'x' }),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const { listener, port } = await listen(env);
    assert.deepEqual(readJson(file).addresses, [`127.0.0.1:${port}`], text);
    assert.equal(readJson(file).processStartedAt, started);
    await listener.close();
  }
});

test('without ps, listen.json has no processStartedAt and still names the pid', async () => {
  const { env, file, base } = plainWorld();
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  const saved = process.env.PATH;
  let pending;
  process.env.PATH = empty;
  try {
    pending = listen(env);
  } finally {
    process.env.PATH = saved;
  }
  const { listener } = await pending;
  const record = readJson(file);
  assert.equal(record.pid, process.pid);
  assert.equal(Object.hasOwn(record, 'processStartedAt'), false);
  await listener.close();
});

test('a listen folder that cannot be made: the start fails with cannot write, and nothing listens', async () => {
  const { env, file } = plainWorld();
  fs.mkdirSync(env[STATE_KEY], { recursive: true });
  fs.writeFileSync(path.join(env[STATE_KEY], 'listen'), 'a file in the way');
  // The folder cannot be made (EEXIST), so the claim tries to move listen.json aside, which cannot be done either.
  await assert.rejects(listen(env), { message: new RegExp(`^cannot write ${file}: ENOTDIR: not a directory, rename '${file}' -> '${file}\\.${process.pid}\\.[0-9a-f]{12}\\.old'$`) });
  assert.equal(fs.readFileSync(path.join(env[STATE_KEY], 'listen'), 'utf8'), 'a file in the way');
  // A state folder that is a file: the first error is not EEXIST.
  const other = plainWorld();
  fs.writeFileSync(other.env[STATE_KEY], 'a file in the way');
  await assert.rejects(listen(other.env), { message: new RegExp(`^cannot write ${other.file}: ENOTDIR: `) });
});

test('an address in use: the start fails and closes what it opened', async () => {
  const { env, file } = plainWorld();
  const busy = net.createServer();
  await new Promise((resolve) => { busy.listen(0, '127.0.0.1', resolve); });
  helpers.push(busy);
  await assert.rejects(startListener({
    addresses: [LOOP, { host: '127.0.0.1', port: busy.address().port, family: 4 }], tls: null, projects: new Map(), env, onEvent: () => {},
  }), { code: 'EADDRINUSE' });
  assert.equal(fs.existsSync(file), false);
});

test('64 connections are served; server.maxConnections closes the 65th at once, and two addresses share the limit', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  // One address may have every connection here; the limit of one address is tested on its own.
  const { listener, port } = await listen(env, { limits: { maxPerAddress: 64 } });
  assert.equal(LISTEN_LIMITS.maxConnections, 64);
  await rpcResult(port, token, PING);
  const open = () => listener.clients()[0].open;
  await waitFor(() => open() === 0, 10000, 'the first connection to close');
  const sockets = [];
  for (let i = 0; i < 64; i += 1) sockets.push(await connect(port));
  await waitFor(() => open() === 64, 10000, '64 open connections');
  // The 65th: the system accepts it, then the server closes it before it reads a byte, and answers nothing.
  const extra = dropped(port, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\n\r\n`);
  await waitFor(() => extra.closed, 10000, 'the 65th connection to be closed');
  assert.equal(extra.received, '');
  assert.equal(open(), 64);
  await assert.rejects(send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) }), { code: 'ECONNRESET' });
  sockets.pop().destroy();
  await waitFor(() => open() === 63, 10000, 'one connection to close');
  await rpcResult(port, token, PING);
  for (const socket of sockets) socket.destroy();
  await waitFor(() => open() === 0, 10000, 'every connection to close');
  await listener.close();

  const two = await listen(env, { addresses: [LOOP, LOOP], limits: { maxConnections: 2 } });
  assert.equal(two.ports.length, 2);
  assert.notEqual(two.ports[0], two.ports[1]);
  await rpcResult(two.ports[1], token, PING);
  await waitFor(() => two.listener.clients()[0].open === 0, 10000, 'the first connection to close');
  const kept =[await connect(two.ports[0]), await connect(two.ports[1])];
  await waitFor(() => two.listener.clients()[0].open === 2, 10000, 'two open connections');
  const third = dropped(two.ports[1], '');
  await waitFor(() => third.closed, 10000, 'the third connection to be closed');
  assert.equal(third.received, '');
  for (const socket of kept) socket.destroy();
  await two.listener.close();
});

test('a request that is not complete within requestMs is cut, and an idle connection is closed after idleMs', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const { listener, port } = await listen(env, { limits: { requestMs: 300, idleMs: 300 } });
  const host = `Host: 127.0.0.1:${port}\r\n`;

  let from = Date.now();
  const half = await connect(port);
  half.write(`POST /mcp HTTP/1.1\r\n${host}`);
  await waitFor(() => half.closed, 10000, 'the half request to be cut');
  assert.ok(Date.now() - from >= 250, `cut after ${Date.now() - from} ms`);
  const timedOut = 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n';
  assert.equal(half.received, timedOut);

  from = Date.now();
  const slow = await connect(port);
  slow.write(`POST /mcp HTTP/1.1\r\n${host}Authorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"jsonrpc"`);
  await waitFor(() => slow.closed, 10000, 'the slow body to be cut');
  assert.ok(Date.now() - from >= 250, `cut after ${Date.now() - from} ms`);
  assert.equal(slow.received, timedOut);

  const idle = await connect(port);
  const body = JSON.stringify(PING);
  from = Date.now();
  idle.write(`POST /mcp HTTP/1.1\r\n${host}Authorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  await waitFor(() => idle.received.includes('"result":{}'), 10000, 'the answer');
  assert.match(idle.received, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(idle.received, /\r\nKeep-Alive: timeout=\d+\r\n/);
  await waitFor(() => idle.closed, 10000, 'the idle connection to be closed');
  assert.ok(Date.now() - from >= 250, `closed after ${Date.now() - from} ms`);
  await listener.close();
});

test('an aborted body or an onEvent that throws cuts only that request', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  let throwing = true;
  const listener = await startListener({
    addresses: [LOOP],
    tls: null,
    projects: new Map([[null, env]]),
    env,
    onEvent: () => {
      if (throwing) throw new Error('the terminal is gone');
    },
  });
  listeners.push(listener);
  const port = Number(listener.bound[0].split(':')[1]);
  await assert.rejects(rpc(port, token, PING), { code: 'ECONNRESET' });
  throwing = false;
  await rpcResult(port, token, PING);
  await waitFor(() => listener.clients()[0].open === 0, 10000, 'the connections to close');

  const aborted = await connect(port);
  aborted.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"js`);
  await waitFor(() => listener.clients()[0].open === 1, 10000, 'the connection to be open');
  aborted.destroy();
  await waitFor(() => listener.clients()[0].open === 0, 10000, 'the connection to be closed');
  await rpcResult(port, token, PING);
  // The call whose event threw was counted before the event; the aborted body never was.
  assert.equal(listener.clients()[0].calls, 3);
  await listener.close();
});

test('TLS with the owner\'s certificate', async () => {
  const { env, file } = plainWorld();
  const token = newToken(env);
  const { cert, key } = selfSigned('localhost');
  const { listener, port } = await listen(env, { tls: { cert: Buffer.from(cert), key: Buffer.from(key) } });
  assert.equal(readJson(file).tls, true);
  const tls = { ca: cert, servername: 'localhost' };
  assert.deepEqual(await rpcResult(port, token, PING, { tls }), { jsonrpc: '2.0', id: 1, result: {} });
  const plain = await send(port, { tls, headers: { ...jsonHeaders(token), host: '127.0.0.1' }, body: JSON.stringify(PING) });
  assert.equal(plain.status, 421, 'a Host without a port means 443 over TLS');
  await assert.rejects(send(port, { headers: jsonHeaders(token), body: JSON.stringify(PING) }));
  await listener.close();
});

test('TLS material that cannot make a server: the start fails, and listen.json is released before the error is thrown', async () => {
  const { env, file } = plainWorld();
  const good = selfSigned('localhost');
  const other = selfSigned('localhost');
  const cases = [
    [{ cert: Buffer.from('not a certificate'), key: Buffer.from('not a key') }, /PEM|no start line/],
    [{ cert: Buffer.from(good.cert), key: Buffer.from(other.key) }, /key values mismatch/],
  ];
  for (const [tls, message] of cases) {
    await assert.rejects(listen(env, { tls }), { message });
    assert.equal(fs.existsSync(file), false, String(message));
  }
  // The claim is free again: a start with good material listens.
  const { listener } = await listen(env, { tls: { cert: Buffer.from(good.cert), key: Buffer.from(good.key) } });
  assert.equal(readJson(file).tls, true);
  await listener.close();
});

const hasV6Loopback = Object.values(os.networkInterfaces()).flat().some((entry) => entry.address === '::1');

test('an IPv6 loopback address: the bound text in brackets and its Host', { skip: !hasV6Loopback && 'no ::1 on this machine' }, async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const { listener, port } = await listen(env, { addresses: [{ host: '::1', port: 0, family: 6 }] });
  assert.deepEqual(listener.bound, [`[::1]:${port}`]);
  const ask = (host) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '::1', port, method: 'POST', path: '/mcp', headers: { ...jsonHeaders(token), host }, agent: false,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify(PING));
  });
  assert.equal(await ask(`[::1]:${port}`), 200);
  assert.equal(await ask(`[0:0:0:0:0:0:0:1]:${port}`), 200);
  assert.equal(await ask(`localhost:${port}`), 200);
  assert.equal(await ask(`127.0.0.1:${port}`), 421);
  assert.equal(listener.clients()[0].from, '::1');
  await listener.close();
});

// --- Full calls through running sessions of two projects ---

function writeInventory(w, project, inventory) {
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${project}.json`), JSON.stringify(inventory));
}

const auditOf = (w, project) => fs.readFileSync(path.join(w.env[STATE_KEY], 'p', project, 'logs', 'audit.log'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event === 'call' || e.event === 'list');

test('tools/list and tools/call through /p/shop/mcp reach shop\'s ssh and brokered targets, /p/ops/mcp reaches only ops', async () => {
  const w = await makeWorld({ extraEnv: { [HEALTH_KEY]: '60000', [VAULT_VAR]: VAULT_VALUE } });
  delete w.env[PROJECT_KEY];
  const sshLog = path.join(w.base, 'ssh.log');
  const pidLog = path.join(w.base, 'ssh-pids.log');
  writeInventory(w, 'shop', {
    ssh: [{
      name: 'web1', host: 'web1.shop.example', description: 'shop web box', allow: ['uptime', 'cat *', 'slow'],
    }],
    vault: [{
      name: 'v1', tokenEnv: VAULT_VAR, description: 'shop vault', allow: ['read *'],
    }],
  });
  writeInventory(w, 'ops', { ssh: [{ name: 'web1', host: 'web1.ops.example', description: 'ops web box', allow: ['uptime', 'cat *'] }] });
  const runs = { shop: launch({ env: withProject(w.env, 'shop') }, { all: true }), ops: launch({ env: withProject(w.env, 'ops') }, { all: true }) };
  await ready(runs.shop);
  await ready(runs.ops);
  try {
    const served = (project) => {
      const env = { ...withProject(w.env, project), [SSH_LOG_KEY]: sshLog, [SSH_PID_KEY]: pidLog };
      delete env[VAULT_VAR];
      return env;
    };
    const token = newToken(w.env);
    const { listener, port, events } = await listen(w.env, { projects: new Map([['shop', served('shop')], ['ops', served('ops')]]) });
    const call = (project, name, args) => rpcResult(port, token, {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args },
    }, { target: `/p/${project}/mcp` });
    const text = (answer) => answer.result.content[0].text;

    const init = await rpcResult(port, token, INIT, { target: '/p/shop/mcp' });
    assert.match(init.result.instructions, /"ksproxy start --project shop"/);
    const tools = async (project) => (await rpcResult(port, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { target: `/p/${project}/mcp` }))
      .result.tools.map((t) => t.name);
    assert.ok((await tools('shop')).includes('vault_read'));
    assert.ok(!(await tools('ops')).includes('vault_read'));

    const listed = (answer) => JSON.parse(text(answer)).targets.map((t) => `${t.kind}:${t.name}:${t.description}`);
    assert.deepEqual(listed(await call('shop', 'list_targets', {})), ['ssh:web1:shop web box', 'vault:v1:shop vault']);
    assert.deepEqual(listed(await call('ops', 'list_targets', {})), ['ssh:web1:ops web box']);
    assert.equal(text(await call('shop', 'ssh_exec', { server: 'web1', command: 'cat shop' })), 'exit code: 0\n--- stdout ---\nran web1 cat shop');
    assert.equal(
      text(await call('shop', 'vault_read', { target: 'v1', command: 'read a' })),
      `exit code: 0\n--- stdout ---\nvault v1: read a with a token of ${VAULT_VALUE.length} characters`,
    );
    assert.equal(text(await call('ops', 'ssh_exec', { server: 'web1', command: 'cat ops' })), 'exit code: 0\n--- stdout ---\nran web1 cat ops');
    const opsVault = await call('ops', 'vault_read', { target: 'v1', command: 'read a' });
    assert.deepEqual([text(opsVault), opsVault.result.isError], ['unknown vault target "v1". Open targets: none', true]);
    assert.equal((await send(port, { target: '/p/nope/mcp', headers: jsonHeaders(token), body: JSON.stringify(PING) })).status, 404);
    assert.equal((await send(port, { target: '/mcp', headers: jsonHeaders(token), body: JSON.stringify(PING) })).status, 404);

    const origin = (e) => `${e.from}|${e.client}`;
    const shopEntries = auditOf(w, 'shop');
    assert.deepEqual(shopEntries.map((e) => [e.event, e.target ?? '', e.command ?? '']), [
      ['list', '', ''], ['call', 'web1', 'cat shop'], ['call', 'v1', 'read a'],
    ]);
    assert.deepEqual([...new Set(shopEntries.map(origin))], ['127.0.0.1|test-agent 1.0']);
    const opsEntries = auditOf(w, 'ops');
    assert.deepEqual(opsEntries.map((e) => [e.event, e.target ?? '', e.command ?? '']), [['list', '', ''], ['call', 'web1', 'cat ops'], ['call', 'v1', 'read a']]);
    assert.deepEqual([...new Set(opsEntries.map(origin))], ['127.0.0.1|test-agent 1.0']);
    for (const project of ['shop', 'ops']) {
      const text2 = fs.readFileSync(path.join(w.env[STATE_KEY], 'p', project, 'logs', 'audit.log'), 'utf8');
      assert.ok(!text2.includes(token) && !text2.includes(VAULT_VALUE));
    }
    assert.deepEqual(events, [{
      type: 'connected', from: '127.0.0.1', client: 'test-agent 1.0', project: 'shop',
    }]);
    assert.deepEqual(listener.clients()[0].projects, ['shop', 'ops']);

    // Closing the listener ends a call that is running: its child is killed at once, so close returns well before the
    // call's time limit and before closeWaitMs, and the call is audited before close returns.
    const running = rpc(port, token, {
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'ssh_exec', arguments: { server: 'web1', command: 'slow', timeout_seconds: 600 } },
    }, { target: '/p/shop/mcp' }).catch(() => null);
    const pidText = () => (fs.existsSync(pidLog) ? fs.readFileSync(pidLog, 'utf8').trim() : '');
    await waitFor(() => pidText() !== '', 10000, 'the slow call to run');
    const pid = Number(pidText());
    assert.equal(alive(pid), true, 'the child of the call runs when the listener closes');
    const from = Date.now();
    await listener.close();
    assert.ok(Date.now() - from < LISTEN_LIMITS.closeWaitMs, `close took ${Date.now() - from} ms`);
    assert.equal(alive(pid), false, 'the child of the call is gone');
    const slow = auditOf(w, 'shop').find((e) => e.command === 'slow');
    assert.deepEqual([slow.decision, slow.timedOut, slow.exitCode, slow.from], ['allowed', false, null, '127.0.0.1']);
    await running;
    assert.equal(fs.existsSync(listenPath(w.env)), false);
  } finally {
    assert.equal(await stopWith(runs.shop), 0);
    assert.equal(await stopWith(runs.ops), 0);
  }
});
