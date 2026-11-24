import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vault from './fixtures/kind-brokered.js';
import { startCallServer } from '../src/broker.js';
import { KINDS } from '../src/kinds/index.js';
import { LISTEN_LIMITS, clientBook, startListener } from '../src/listen.js';
import { PROJECT_KEY, callSocketPath, sessionDir } from '../src/paths.js';
import { writeSession } from '../src/session.js';
import { newToken } from '../src/token.js';
import { waitFor } from './start-helpers.js';
import { tempDir } from './temp.js';

KINDS.push(vault);

const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const LOOP = Object.freeze({ host: '127.0.0.1', port: 0, family: 4 });
const T0 = Date.parse('2026-11-22T10:00:00.000Z');
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const CALL = JSON.stringify({
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vault_read', arguments: { target: 'v1', command: 'read a' } },
});
const BUSY = 'too many calls at once; try again soon';

const listeners = [];
const helpers = [];
after(async () => {
  for (const listener of listeners) await listener.close();
  for (const helper of helpers) await helper.close();
});

function plainWorld() {
  const base = fs.realpathSync(tempDir('ks-limits-'));
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
  return { listener, events, port: Number(listener.bound[0].split(':')[1]) };
}

const jsonHeaders = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

// One HTTP request with no connection reuse: the status, the headers and the body as text.
function send(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers, agent: false,
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

// A raw connection that never rejects: it writes text once connected and keeps what it receives.
function raw(port, text = '') {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.received = '';
  socket.on('data', (chunk) => { socket.received += chunk.toString('utf8'); });
  socket.on('error', () => {});
  socket.on('connect', () => socket.write(text));
  return socket;
}

// The head of a request to /mcp, with the token, the type and the length given, and any other header lines.
function head(port, { token, type = 'application/json', length, extra = '' }) {
  const lines = [`POST /mcp HTTP/1.1`, `Host: 127.0.0.1:${port}`];
  if (token !== undefined) lines.push(`Authorization: Bearer ${token}`);
  lines.push(`Content-Type: ${type}`, `Content-Length: ${length}`);
  return `${lines.join('\r\n')}\r\n${extra}\r\n`;
}

const CONTINUE = 'HTTP/1.1 100 Continue\r\n\r\n';

// A session of the default with one brokered target, and a stand-in for its call socket: each call waits until the test
// lets it end, so the test knows how many calls run.
async function brokeredSession(env) {
  writeSession(sessionDir(env), {
    version: 1, pid: process.pid, startedAt: 't', targets: [{ kind: 'vault', name: 'v1', state: 'up' }],
  });
  fs.mkdirSync(path.dirname(callSocketPath(env)), { recursive: true });
  const seen = [];
  const ends = [];
  const server = await startCallServer({
    socket: callSocketPath(env),
    handle: (request) => new Promise((resolve) => {
      seen.push(request);
      ends.push(() => resolve({ text: `done ${seen.length}`, isError: false }));
    }),
  });
  helpers.push(server);
  return { seen, end: (i) => ends[i]() };
}

test('the limits of running calls and of the connections of one address are 16 each, and close waits at most 5 seconds', () => {
  assert.equal(LISTEN_LIMITS.maxCalls, 16);
  assert.equal(LISTEN_LIMITS.maxPerAddress, 16);
  assert.equal(LISTEN_LIMITS.closeWaitMs, 5000);
});

test('close waits for a running brokered call at most closeWaitMs, then cuts it; a second close waits for the same close', async () => {
  const { env, file } = plainWorld();
  const token = newToken(env);
  const calls = await brokeredSession(env);
  const { listener, port } = await listen(env, { limits: { closeWaitMs: 300 } });
  const client = raw(port, `${head(port, { token, length: CALL.length })}${CALL}`);
  await waitFor(() => calls.seen.length === 1, 10000, 'the call to run');
  const from = Date.now();
  const first = listener.close();
  const second = listener.close();
  assert.equal(second, first, 'one close, given to every caller');
  await first;
  // The session's call goes on: it gets no signal, and ends when its session stops.
  assert.ok(Date.now() - from >= 250, `close returned after ${Date.now() - from} ms`);
  await waitFor(() => client.closed, 10000, 'the connection to be cut');
  assert.equal(client.received, '');
  assert.equal(fs.existsSync(file), false);
  calls.end(0);
  // A close with no running call does not wait.
  const again = await listen(env, { limits: { closeWaitMs: 60000 } });
  const quick = Date.now();
  await again.listener.close();
  assert.ok(Date.now() - quick < 10000);
});

test('at maxCalls running calls, a request gets 503 after the token and before its body; a call whose client left still counts until it ends', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const calls = await brokeredSession(env);
  const { listener, port } = await listen(env, { limits: { maxCalls: 2 } });
  const first = raw(port, `${head(port, { token, length: CALL.length })}${CALL}`);
  const second = raw(port, `${head(port, { token, length: CALL.length })}${CALL}`);
  await waitFor(() => calls.seen.length === 2, 10000, 'two calls to run');

  // Its head alone gets the answer: the body is never read, and no 100 Continue comes first.
  const third = raw(port, head(port, { token, length: 100, extra: 'Expect: 100-continue\r\n' }));
  await waitFor(() => third.closed, 10000, 'the third request to be answered and closed');
  assert.match(third.received, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.match(third.received, /\r\nRetry-After: 1\r\n/);
  assert.match(third.received, /\r\nConnection: close\r\n/);
  assert.ok(third.received.endsWith(`\r\n\r\n${BUSY}`), third.received);
  // The token comes first; a ping is a message too.
  assert.equal((await send(port, jsonHeaders('ksp_wrong'), PING)).status, 401);
  const busy = await send(port, jsonHeaders(token), PING);
  assert.deepEqual([busy.status, busy.headers['retry-after'], busy.body], [503, '1', BUSY]);

  // The client of the first call leaves: the call goes on in the session and keeps its place.
  first.destroy();
  await waitFor(() => listener.clients()[0].open === 1, 10000, 'the first connection to close');
  assert.equal((await send(port, jsonHeaders(token), PING)).status, 503);
  assert.equal(calls.seen.length, 2);
  // Once that call ends, its place is free.
  calls.end(0);
  await waitFor(async () => (await send(port, jsonHeaders(token), PING)).status === 200, 10000, 'a place to be free');
  calls.end(1);
  await waitFor(() => second.received.includes('done 2'), 10000, 'the answer of the second call');
  assert.match(second.received, /^HTTP\/1\.1 200 OK\r\n/);
  second.destroy();
  assert.equal(listener.clients()[0].calls, 3, 'the two calls and the ping that got in were handed on; the refused ones were not');
});

test('a request whose body comes after the last free place was taken gets 503 as its message would be handed on', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const calls = await brokeredSession(env);
  const { listener, port } = await listen(env, { limits: { maxCalls: 2 } });
  const first = raw(port, `${head(port, { token, length: CALL.length })}${CALL}`);
  await waitFor(() => calls.seen.length === 1, 10000, 'one call to run');
  // One place is free: this request passes the check before its body, and is told to send it.
  const late = raw(port, head(port, { token, length: PING.length, extra: 'Expect: 100-continue\r\n' }));
  await waitFor(() => late.received === CONTINUE, 10000, '100 Continue');
  const second = raw(port, `${head(port, { token, length: CALL.length })}${CALL}`);
  await waitFor(() => calls.seen.length === 2, 10000, 'the second call to run');
  late.write(PING);
  await waitFor(() => late.closed, 10000, 'the late request to be answered and closed');
  assert.match(late.received.slice(CONTINUE.length), /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.ok(late.received.endsWith(BUSY));
  assert.equal(listener.clients()[0].calls, 2);
  calls.end(0);
  calls.end(1);
  await waitFor(() => first.received.includes('done') && second.received.includes('done'), 10000, 'both answers');
  first.destroy();
  second.destroy();
});

test('Expect: 100-continue: 100 Continue comes only after the token, the call limit, the content type and the declared size', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const { port } = await listen(env, { limits: { maxBody: 200 } });
  const expect = 'Expect: 100-continue\r\n';
  const refusedFirst = async (text, status) => {
    const socket = raw(port, text);
    await waitFor(() => socket.closed, 10000, `the answer ${status}`);
    assert.ok(socket.received.startsWith(`HTTP/1.1 ${status} `), socket.received);
    assert.ok(!socket.received.includes('100 Continue'), socket.received);
  };
  await refusedFirst(head(port, { token, length: 10, extra: expect }).replace('/mcp', '/nope'), 404);
  await refusedFirst(head(port, { length: 10, extra: expect }), 401);
  await refusedFirst(head(port, { token: 'ksp_wrong', length: 10, extra: expect }), 401);
  await refusedFirst(head(port, {
    token, type: 'text/plain', length: 10, extra: expect,
  }), 415);
  await refusedFirst(head(port, { token, length: 201, extra: expect }), 413);

  const good = raw(port, head(port, { token, length: PING.length, extra: expect }));
  await waitFor(() => good.received === CONTINUE, 10000, '100 Continue');
  good.write(PING);
  await waitFor(() => good.received.includes('"result":{}'), 10000, 'the answer');
  assert.match(good.received.slice(CONTINUE.length), /^HTTP\/1\.1 200 OK\r\n/);
  good.destroy();
  // Without Expect, no 100 Continue is sent.
  const plain = raw(port, `${head(port, { token, length: PING.length })}${PING}`);
  await waitFor(() => plain.received.includes('"result":{}'), 10000, 'the answer');
  assert.match(plain.received, /^HTTP\/1\.1 200 OK\r\n/);
  plain.destroy();
});

test('the 17th open connection of one address is closed at once, before a byte is read', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const { listener, port } = await listen(env);
  assert.equal((await send(port, jsonHeaders(token), PING)).status, 200);
  const open = () => listener.clients()[0].open;
  await waitFor(() => open() === 0, 10000, 'the first connection to close');
  const sockets = [];
  for (let i = 0; i < 16; i += 1) sockets.push(raw(port));
  await waitFor(() => open() === 16, 10000, '16 open connections');
  const extra = raw(port, `${head(port, { token, length: PING.length })}${PING}`);
  await waitFor(() => extra.closed, 10000, 'the 17th connection to be closed');
  assert.equal(extra.received, '');
  assert.equal(open(), 16);
  sockets.pop().destroy();
  await waitFor(() => open() === 15, 10000, 'one connection to close');
  assert.equal((await send(port, jsonHeaders(token), PING)).status, 200);
  for (const socket of sockets) socket.destroy();
  await waitFor(() => open() === 0, 10000, 'every connection to close');
});

test('a socket with no address, such as one the peer has already reset, is closed before it is counted', async () => {
  const { env } = plainWorld();
  const token = newToken(env);
  const made = [];
  const real = http.createServer;
  http.createServer = (...args) => {
    const server = real(...args);
    made.push(server);
    return server;
  };
  let started;
  try {
    started = await listen(env, { limits: { maxConnections: 1 } });
  } finally {
    http.createServer = real;
  }
  const { listener, port } = started;
  // The connection listener of the listener is the last one: Node adds its own when it makes the server.
  const admit = made[0].listeners('connection').at(-1);
  const socket = new net.Socket();
  assert.equal(socket.remoteAddress, undefined);
  admit(socket);
  assert.equal(socket.destroyed, true);
  // Had it been counted, it would hold the one place: a request still gets in.
  assert.equal((await send(port, jsonHeaders(token), PING)).status, 200);
  assert.deepEqual(listener.clients().map((client) => client.from), ['127.0.0.1']);
});

test('refused events: the first wrong token at once, the others at the next report, at most 10 addresses by name and one event for the rest', () => {
  const events = [];
  const book = clientBook({ limits: LISTEN_LIMITS, onEvent: (event) => events.push(event), changed: () => {} });
  const t = (ms) => new Date(T0 + ms);
  const a = '192.0.2.1';
  // A burst of ten in one second: one event at once, then one with the nine others.
  for (let i = 0; i < 10; i += 1) book.wrong(a, t(i * 100));
  assert.deepEqual(events, [{ type: 'refused', from: a, count: 1 }]);
  book.report();
  assert.deepEqual(events.slice(1), [{ type: 'refused', from: a, count: 9 }]);
  // The next wrong token waits for the next report, which still comes after the one that reported.
  book.wrong(a, t(70000));
  assert.equal(events.length, 2);
  book.report();
  assert.deepEqual(events.slice(2), [{ type: 'refused', from: a, count: 1 }]);
  // A report with nothing new reports nothing; the report after that finds the address quiet, so its next wrong
  // token is reported at once again.
  book.report();
  assert.equal(events.length, 3);
  book.wrong(a, t(200000));
  assert.deepEqual(events.slice(3), [{ type: 'refused', from: a, count: 1 }]);
  book.report();
  book.report();
  assert.equal(events.length, 4);

  // Twelve addresses with waiting wrong tokens, the first with one, the last with twelve: ten by name, in the order
  // they were first seen, then the two others in one event with their sum. Only the first ten are reported at once:
  // the first wrong tokens of the eleventh and the twelfth wait too.
  events.length = 0;
  const many = Array.from({ length: 12 }, (_, i) => `192.0.2.${20 + i}`);
  for (const [i, from] of many.entries()) {
    for (let k = 0; k <= i + 1; k += 1) book.wrong(from, t(300000 + k));
  }
  assert.deepEqual(events, many.slice(0, 10).map((from) => ({ type: 'refused', from, count: 1 })), 'one at once for each of ten');
  events.length = 0;
  book.report();
  assert.deepEqual(events, [
    ...many.slice(0, 10).map((from, i) => ({ type: 'refused', from, count: i + 1 })),
    { type: 'refused', from: '2 other addresses', count: 12 + 13 },
  ]);
  // Eleven waiting: one other address.
  events.length = 0;
  for (const from of many.slice(1)) book.wrong(from, t(400000));
  book.report();
  assert.equal(events.length, 11);
  assert.deepEqual(events.at(-1), { type: 'refused', from: '1 other address', count: 1 });
});

test('refused events have an overall bound: 500 new addresses give at most 10 events before the first tick, then 11', () => {
  const events = [];
  const book = clientBook({ limits: LISTEN_LIMITS, onEvent: (event) => events.push(event), changed: () => {} });
  const froms = Array.from({ length: 500 }, (_, i) => `fd00::${i.toString(16)}`);
  for (const from of froms) book.wrong(from, new Date(T0));
  assert.deepEqual(events, froms.slice(0, 10).map((from) => ({ type: 'refused', from, count: 1 })));
  events.length = 0;
  book.report();
  assert.deepEqual(events, [
    ...froms.slice(10, 20).map((from) => ({ type: 'refused', from, count: 1 })),
    { type: 'refused', from: '480 other addresses', count: 480 },
  ]);
  // The tick starts a new window: ten more can be reported at once, among them the ten reported at once before, which
  // have nothing waiting any more.
  events.length = 0;
  book.report();
  assert.deepEqual(events, []);
  for (const from of froms.slice(0, 12)) book.wrong(from, new Date(T0 + 1000));
  assert.deepEqual(events, froms.slice(0, 10).map((from) => ({ type: 'refused', from, count: 1 })));
});

test('the report timer runs every wrongWindowMs while the listener runs, and an onEvent that throws does not stop it', async () => {
  const { env } = plainWorld();
  const events = [];
  const listener = await startListener({
    addresses: [LOOP],
    tls: null,
    projects: new Map([[null, env]]),
    env,
    onEvent: (event) => {
      events.push(event);
      if (event.count === 2) throw new Error('the terminal is gone');
    },
    limits: { wrongWindowMs: 100 },
  });
  listeners.push(listener);
  const port = Number(listener.bound[0].split(':')[1]);
  newToken(env);
  // Three wrong tokens in one write: Node reads them in one pass, so no tick of the timer comes between them.
  const wrong = `${head(port, { token: 'ksp_wrong', length: PING.length })}${PING}`;
  const burst = raw(port, wrong.repeat(3));
  await waitFor(() => burst.closed, 10000, 'the answer to the burst');
  assert.match(burst.received, /^HTTP\/1\.1 401 /);
  assert.deepEqual(events[0], { type: 'refused', from: '127.0.0.1', count: 1 });
  await waitFor(() => events.length === 2, 10000, 'the report of the two others');
  assert.deepEqual(events[1], { type: 'refused', from: '127.0.0.1', count: 2 });
  // The event that threw was lost; the listener and its timer go on.
  assert.equal((await send(port, jsonHeaders('ksp_wrong'), PING)).status, 401);
  await waitFor(() => events.length === 3, 10000, 'the next refused event');
  assert.deepEqual(events[2], { type: 'refused', from: '127.0.0.1', count: 1 });
  await listener.close();
});

test('a full client book drops the record seen first that is neither blocked nor connected, then one not connected, then the first', () => {
  const book = clientBook({ limits: { ...LISTEN_LIMITS, maxClients: 3 }, onEvent: () => {}, changed: () => {} });
  const t = (ms) => new Date(T0 + ms);
  const block = (from, at) => {
    for (let i = 0; i < LISTEN_LIMITS.wrongMax; i += 1) book.wrong(from, at);
  };
  const froms = () => book.list().map((record) => record.from);
  block('192.0.2.1', t(0));
  book.opened('192.0.2.2');
  book.called('192.0.2.2', 'shop', t(0));
  book.called('192.0.2.3', 'shop', t(0));
  book.called('192.0.2.4', 'shop', t(1000));
  assert.deepEqual(froms(), ['192.0.2.1', '192.0.2.2', '192.0.2.4'], 'neither blocked nor connected');
  assert.equal(book.blockedMs('192.0.2.1', t(1000)), 59000, 'the block stays');
  block('192.0.2.4', t(2000));
  book.called('192.0.2.5', 'shop', t(3000));
  assert.deepEqual(froms(), ['192.0.2.2', '192.0.2.4', '192.0.2.5'], 'every record blocked or connected: the first not connected');
  book.opened('192.0.2.4');
  book.opened('192.0.2.5');
  book.called('192.0.2.6', 'shop', t(4000));
  assert.deepEqual(froms(), ['192.0.2.4', '192.0.2.5', '192.0.2.6'], 'every record connected: the first');
  // A block that has ended is no block.
  book.closed('192.0.2.4');
  book.closed('192.0.2.5');
  book.called('192.0.2.7', 'shop', t(70000));
  assert.deepEqual(froms(), ['192.0.2.5', '192.0.2.6', '192.0.2.7']);
});

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('listen.json is claimed with an exclusive create before anything listens; a file in the way that is not a live listener is moved aside once', async () => {
  const { env, file } = plainWorld();
  const pending = startListener({
    addresses: [LOOP], tls: null, projects: new Map([[null, env]]), env, onEvent: () => {},
  });
  // The claim is made at once, before the address listens.
  assert.deepEqual(readJson(file).addresses, []);
  assert.equal(readJson(file).pid, process.pid);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const listener = await pending;
  listeners.push(listener);
  assert.deepEqual(readJson(file).addresses, listener.bound);
  await assert.rejects(listen(env), { message: `another ksproxy start is listening (pid ${process.pid})` });
  await listener.close();
  assert.equal(fs.existsSync(file), false);

  // A file of a dead pid is moved aside under a name of this process alone, removed, and claimed again.
  const dir = path.dirname(file);
  fs.writeFileSync(file, JSON.stringify({ version: 1, pid: deadPid(), addresses: ['127.0.0.1:1'], clients: [] }));
  const moved = [];
  const again = await withRenameOf(file, (rename, to) => {
    moved.push(to);
    return rename(file, to);
  }, () => listen(env));
  assert.equal(moved.length, 1);
  assert.match(moved[0], new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${process.pid}\\.[0-9a-f]{12}\\.old$`));
  assert.equal(readJson(file).pid, process.pid);
  assert.deepEqual(fs.readdirSync(dir), ['listen.json'], 'the old file is removed');
  await again.listener.close();

  // A folder in the place of the file is moved aside too; it cannot be removed as a file, so it stays under that name.
  fs.mkdirSync(path.join(file, 'inside'), { recursive: true });
  const { listener: past } = await listen(env);
  assert.equal(readJson(file).pid, process.pid);
  const kept = fs.readdirSync(dir).filter((name) => name.endsWith('.old'));
  assert.equal(kept.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, kept[0])), ['inside']);
  await past.close();
});

// Runs fn while the first fs.renameSync of listen.json is replaced: replace gets the real renameSync and the new name,
// and does what another start would do at that moment, then this start's own rename or a failure of it.
async function withRenameOf(file, replace, fn) {
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (from !== file) return realRename(from, to);
    fs.renameSync = realRename;
    return replace(realRename, to);
  };
  try {
    return await fn();
  } finally {
    fs.renameSync = realRename;
  }
}

const failure = (code, message) => Object.assign(new Error(`${code}: ${message}, rename`), { code });

test('two starts that find the same dead listen.json: only one claim is made, the other is refused', async () => {
  const { env, file } = plainWorld();
  const dead = () => JSON.stringify({ version: 1, pid: deadPid(), addresses: [], clients: [] });
  const live = JSON.stringify({ version: 1, pid: process.ppid, addresses: [], clients: [] });
  const refusedBy = (pid) => ({ message: `another ksproxy start is listening (pid ${pid})` });
  const aside = `${file}.other.old`;
  const names = () => fs.readdirSync(path.dirname(file)).sort();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // One after the other on the same dead file: the first moves it aside and claims; the second finds a live claim.
  fs.writeFileSync(file, dead());
  const { listener: first } = await listen(env);
  await assert.rejects(listen(env), refusedBy(process.pid));
  await first.close();

  // The other start moved the dead file just before this one renames it: the rename finds nothing, and this one claims.
  fs.writeFileSync(file, dead());
  const { listener: second } = await withRenameOf(file, (rename, to) => {
    rename(file, aside);
    return rename(file, to);
  }, () => listen(env));
  assert.equal(readJson(file).pid, process.pid);
  await second.close();
  assert.deepEqual(names(), ['listen.json.other.old']);
  fs.rmSync(aside);

  // The rename found nothing, and the other start made its claim before this one: refused, the other claim stays.
  fs.writeFileSync(file, dead());
  await assert.rejects(withRenameOf(file, (rename) => {
    rename(file, aside);
    fs.writeFileSync(file, live, { flag: 'wx' });
    throw failure('ENOENT', 'no such file or directory');
  }, () => listen(env)), refusedBy(process.ppid));
  assert.equal(fs.readFileSync(file, 'utf8'), live);
  fs.rmSync(aside);
  fs.rmSync(file);

  // The same, but what is there at the second create names no live listener: this start fails, the file stays.
  const other = dead();
  fs.writeFileSync(file, dead());
  await assert.rejects(withRenameOf(file, (rename) => {
    rename(file, aside);
    fs.writeFileSync(file, other, { flag: 'wx' });
    throw failure('ENOENT', 'no such file or directory');
  }, () => listen(env)), { message: `cannot write ${file}: EEXIST: file already exists, open '${file}'` });
  assert.equal(fs.readFileSync(file, 'utf8'), other);
  fs.rmSync(aside);

  // The other start claimed between this one's check and its rename: what was moved names a live listener, so it is
  // put back and this start is refused.
  await assert.rejects(withRenameOf(file, (rename, to) => {
    rename(file, aside);
    fs.writeFileSync(file, live, { flag: 'wx' });
    return rename(file, to);
  }, () => listen(env)), refusedBy(process.ppid));
  assert.equal(fs.readFileSync(file, 'utf8'), live, 'the claim of the other start is back in place');
  assert.deepEqual(names(), ['listen.json', 'listen.json.other.old']);
  fs.rmSync(aside);

  // A rename that fails for another reason: this start fails, and the file stays.
  fs.writeFileSync(file, other);
  await assert.rejects(withRenameOf(file, () => {
    throw failure('EACCES', 'permission denied');
  }, () => listen(env)), { message: `cannot write ${file}: EACCES: permission denied, rename` });
  assert.deepEqual(names(), ['listen.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), other);
});

test('the close removes listen.json only while it names this process, and a later write that fails leaves the listener running', async () => {
  const { env, file } = plainWorld();
  const token = newToken(env);
  const first = await listen(env, { limits: { listenWriteMs: 1 } });
  const other = { version: 1, pid: deadPid(), addresses: ['127.0.0.1:1'], tls: false, clients: [] };
  fs.writeFileSync(file, JSON.stringify(other));
  await first.listener.close();
  assert.deepEqual(readJson(file), other, 'the file of another start stays');

  fs.rmSync(file);
  const second = await listen(env);
  fs.rmSync(file);
  await second.listener.close();
  assert.equal(fs.existsSync(file), false, 'no file at the close is no error');

  // The listen folder is replaced by a file once the claim is made: the write after the listen fails, the listener runs.
  const pending = startListener({
    addresses: [LOOP], tls: null, projects: new Map([[null, env]]), env, onEvent: () => {},
  });
  fs.rmSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.dirname(file), 'a file in the way');
  const third = await pending;
  listeners.push(third);
  const port = Number(third.bound[0].split(':')[1]);
  const answer = await send(port, jsonHeaders(token), PING);
  assert.deepEqual([answer.status, answer.body], [401, 'the token file cannot be read'], 'the token file is gone with the folder');
  await third.close();
  assert.equal(fs.readFileSync(path.dirname(file), 'utf8'), 'a file in the way');
});
