import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import {
  authHeader, readRequest, send, widenNoProxy,
} from '../src/kinds/engines/http.js';
import { selfSigned } from './fixtures/self-signed.js';
import { tempDir } from './temp.js';

// The transport of send, node:http and node:https, against raw loopback servers of this file: the exact bytes of the
// request, and what each reply becomes. The request and the replies are those that fetch gave before, byte for byte,
// but for "connection: close": one connection per request, closed when the reply was read.

const engine = new URL('../src/kinds/engines/http.js', import.meta.url).pathname;
const { cert, key } = selfSigned('localhost');

// A raw server: it keeps each request as it came (the head and the body its content-length gives), answers it with
// answer(socket), and keeps whether the client ended the connection. tlsOptions makes it a TLS server.
async function rawServer(answer, tlsOptions = null, host = '127.0.0.1') {
  const requests = [];
  const ended = [];
  const sockets = new Set();
  const onConnection = (socket) => {
    sockets.add(socket);
    let data = Buffer.alloc(0);
    let done = false;
    socket.on('error', () => {});
    socket.on('end', () => ended.push(true));
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const text = data.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (done || end === -1) return;
      const length = /\r\ncontent-length: (\d+)/.exec(text.slice(0, end));
      if (length !== null && data.length < end + 4 + Number(length[1])) return;
      done = true;
      requests.push({ text, alpn: socket.alpnProtocol, servername: socket.servername });
      answer(socket);
    });
  };
  const server = tlsOptions === null ? net.createServer(onConnection) : tls.createServer(tlsOptions, onConnection);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  return {
    port,
    requests,
    ended,
    sockets,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

const reply = (status, headers, body = '') => (socket) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const lines = [...headers, ['content-length', String(bytes.length)]].map(([name, value]) => `${name}: ${value}\r\n`).join('');
  socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 ${status}\r\n${lines}\r\n`, 'latin1'), bytes]));
};
const raw = (text) => (socket) => socket.write(Buffer.from(text, 'latin1'));
const rawThenEnd = (text) => (socket) => socket.end(Buffer.from(text, 'latin1'));

const call = (port, input, extra = {}) => send({
  baseUrl: `http://127.0.0.1:${port}/p/`, headers: {}, ...readRequest(input), timeoutMs: 5000, maxBytes: 262144, ...extra,
});
const GET = { method: 'GET', path: '/x' };
const okWith = (stdout, extra = {}) => ({
  exitCode: 0, stdout, stderr: '', ownStderr: true, truncated: false, cutOff: false, ...extra,
});
const REACH = { exitCode: 1, stdout: '', stderr: 'the service could not be reached\n' };
const TIMED_OUT_RESULT = {
  exitCode: null, stdout: '', stderr: '', timedOut: true,
};

const until = async (check, what) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`not in time: ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

test('the request on the wire: the headers fetch sent, in its order, with connection close and the length of a body', async (t) => {
  const server = await rawServer(reply('200 OK', [['content-type', 'application/json']], '{}'));
  t.after(server.close);
  const head = (first, ...rest) => [first, `host: 127.0.0.1:${server.port}`, 'connection: close', ...rest].join('\r\n');
  const fetchTail = ['accept-language: *', 'sec-fetch-mode: cors', 'user-agent: node', 'accept-encoding: gzip, deflate'];

  await call(server.port, { method: 'GET', path: '/x', query: { q: 'a b' } }, { headers: { authorization: 'Bearer tok-1' } });
  assert.equal(server.requests.at(-1).text, `${head('GET /p/x?q=a+b HTTP/1.1', 'authorization: Bearer tok-1', 'accept: application/json, */*', ...fetchTail)}\r\n\r\n`);

  await call(server.port, { method: 'POST', path: '/x', body: { a: 'é' } }, { headers: { 'x-api-key': '  k-1 \t' } });
  assert.equal(server.requests.at(-1).text, `${head('POST /p/x HTTP/1.1', 'x-api-key: k-1', 'accept: application/json, */*', 'content-type: application/json', ...fetchTail, 'content-length: 10')}\r\n\r\n${Buffer.from('{"a":"é"}').toString('latin1')}`);

  // A token with spaces at its ends loses those of the end of the header only; a value of spaces only is sent empty;
  // a basic credential keeps them inside its base64. What is sent is what encodedForms gives to hide.
  await call(server.port, GET, { headers: { authorization: 'Bearer  tok-2 ' } });
  assert.equal(server.requests.at(-1).text, `${head('GET /p/x HTTP/1.1', 'authorization: Bearer  tok-2', 'accept: application/json, */*', ...fetchTail)}\r\n\r\n`);
  await call(server.port, GET, { headers: { 'x-api-key': '   ' } });
  assert.equal(server.requests.at(-1).text, `${head('GET /p/x HTTP/1.1', 'x-api-key: ', 'accept: application/json, */*', ...fetchTail)}\r\n\r\n`);
  const basic = authHeader({ basicUserEnv: 'U', basicPasswordEnv: 'P' }, { U: ' ops', P: 'pw ' });
  await call(server.port, GET, { headers: basic });
  assert.equal(server.requests.at(-1).text, `${head('GET /p/x HTTP/1.1', `authorization: Basic ${Buffer.from(' ops:pw ').toString('base64')}`, 'accept: application/json, */*', ...fetchTail)}\r\n\r\n`);

  for (const method of ['POST', 'PUT', 'PATCH']) {
    await call(server.port, { method, path: '/x' });
    assert.equal(server.requests.at(-1).text, `${head(`${method} /p/x HTTP/1.1`, 'accept: application/json, */*', ...fetchTail, 'content-length: 0')}\r\n\r\n`, method);
  }
  for (const method of ['DELETE', 'HEAD']) {
    await call(server.port, { method, path: '/x' });
    assert.equal(server.requests.at(-1).text, `${head(`${method} /p/x HTTP/1.1`, 'accept: application/json, */*', ...fetchTail)}\r\n\r\n`, method);
  }
  await call(server.port, { method: 'DELETE', path: '/x', body: [1] });
  assert.equal(server.requests.at(-1).text, `${head('DELETE /p/x HTTP/1.1', 'accept: application/json, */*', 'content-type: application/json', ...fetchTail, 'content-length: 3')}\r\n\r\n[1]`);
});

test('one connection per request: the client ends it after the reply, and no socket stays', async (t) => {
  const server = await rawServer(reply('200 OK', [], 'ok'));
  t.after(server.close);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await call(server.port, GET), okWith('HTTP 200\ncontent-type: (none)\n\nok'));
  await until(() => server.ended.length === 3 && server.sockets.size === 0, 'three connections ended by the client');
  const limited = await call(server.port, GET, { maxBytes: 1 });
  assert.equal(limited.truncated, true);
  await until(() => server.sockets.size === 0, 'the connection of a reply cut at the limit closed');
});

test('a header value that cannot be sent, a port that fetch refused and a closed port: the service could not be reached', async (t) => {
  const server = await rawServer(reply('200 OK', [], 'ok'));
  t.after(server.close);
  assert.deepEqual(await call(server.port, GET, { headers: { authorization: 'Bearer a\nb' } }), REACH);
  assert.deepEqual(await call(server.port, GET, { headers: { authorization: 'Bearer 日' } }), REACH);
  assert.equal(server.requests.length, 0);
  assert.equal((await call(server.port, GET, { headers: { authorization: 'Bearer é' } })).exitCode, 0);
  assert.ok(server.requests[0].text.includes('authorization: Bearer \xe9\r\n'));
  for (const port of [6000, 6667, 10080]) {
    assert.deepEqual(await send({
      baseUrl: `http://127.0.0.1:${port}/`, headers: {}, ...readRequest(GET), timeoutMs: 2000, maxBytes: 100,
    }), REACH, String(port));
  }
});

test('the encodings fetch decoded, the last first; an unknown one gives the body as it came; the limit counts decoded bytes', async (t) => {
  const gz = (text) => zlib.gzipSync(Buffer.from(text));
  const table = [
    [[['content-encoding', 'gzip'], ['content-type', 'text/plain']], gz('hello gzip'), 'text/plain', 'hello gzip'],
    [[['content-encoding', 'X-Gzip']], gz('x-gzip'), '(none)', 'x-gzip'],
    [[['content-encoding', 'deflate']], zlib.deflateSync('zlib deflate'), '(none)', 'zlib deflate'],
    [[['content-encoding', 'deflate']], zlib.deflateRawSync('raw deflate'), '(none)', 'raw deflate'],
    [[['content-encoding', 'deflate']], Buffer.alloc(0), '(none)', ''],
    [[['content-encoding', 'br']], zlib.brotliCompressSync('brotli'), '(none)', 'brotli'],
    [[['content-encoding', 'zstd']], zlib.zstdCompressSync('zstd'), '(none)', 'zstd'],
    [[['content-encoding', 'gzip, br']], zlib.brotliCompressSync(gz('two layers')), '(none)', 'two layers'],
    [[['content-encoding', 'gzip'], ['Content-Encoding', 'br']], zlib.brotliCompressSync(gz('two headers')), '(none)', 'two headers'],
    [[['content-encoding', 'gzip,gzip,gzip,gzip,gzip']], gz(gz(gz(gz(gz('five'))))), '(none)', 'five'],
    [[['content-encoding', 'compress']], 'as it came', '(none)', 'as it came'],
    [[['content-encoding', 'gzip, foo']], 'as it came too', '(none)', 'as it came too'],
    [[['content-encoding', '']], 'plain', '(none)', 'plain'],
    [[['content-encoding', 'gzip']], Buffer.concat([gz('one'), gz('two')]), '(none)', 'onetwo'],
    [[['content-encoding', 'gzip']], gz('a longer text that is cut off at the end').subarray(0, 25), '(none)', 'a longer text '],
  ];
  for (const [headers, body, type, text] of table) {
    const server = await rawServer(reply('200 OK', headers, body));
    assert.deepEqual(await call(server.port, GET), okWith(`HTTP 200\ncontent-type: ${type}\n\n${text}`), JSON.stringify(headers));
    await server.close();
  }
  const limit = async (headers, body, maxBytes) => {
    const server = await rawServer(reply('200 OK', headers, body));
    t.after(server.close);
    return call(server.port, GET, { maxBytes });
  };
  assert.deepEqual(await limit([['content-encoding', 'gzip']], gz('0123456789'), 10), okWith('HTTP 200\ncontent-type: (none)\n\n0123456789'));
  assert.deepEqual(await limit([['content-encoding', 'gzip']], gz('0123456789A'), 10), okWith('HTTP 200\ncontent-type: (none)\n\n0123456789', { truncated: true }));
  // 50 MiB of one letter in about 50 KiB: the read stops at the limit, long before the end.
  for (const coding of ['gzip', 'deflate']) {
    const bomb = coding === 'gzip' ? zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x61)) : zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024, 0x61));
    assert.deepEqual(await limit([['content-encoding', coding]], bomb, 1000), okWith(`HTTP 200\ncontent-type: (none)\n\n${'a'.repeat(1000)}`, { truncated: true }), coding);
  }
});

test('a body that does not decode is cut off; more than five encodings, a HEAD and a 204 as fetch had them', async (t) => {
  const cut = (text) => ({
    exitCode: 1, stdout: `HTTP 200\ncontent-type: (none)\n\n${text}`, stderr: 'the reply was cut off\n', ownStderr: true, truncated: false, cutOff: true,
  });
  const at = async (answer, input = GET) => {
    const server = await rawServer(answer);
    t.after(server.close);
    return call(server.port, input);
  };
  assert.deepEqual(await at(reply('200 OK', [['content-encoding', 'gzip']], 'not gzip at all')), cut(''));
  assert.deepEqual(await at(reply('200 OK', [['content-encoding', 'deflate']], Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff]))), cut(''));
  assert.deepEqual(await at(reply('200 OK', [['content-encoding', 'gzip']], Buffer.concat([zlib.gzipSync('one'), Buffer.from('junk')]))), cut(''));
  assert.deepEqual(await at(rawThenEnd('HTTP/1.1 200 OK\r\ncontent-encoding: deflate\r\ncontent-length: 100\r\n\r\n')), cut(''));
  assert.deepEqual(await at(reply('200 OK', [['content-encoding', 'identity,identity,identity,identity,identity,identity']], 'x')), REACH);
  assert.deepEqual(await at(reply('302 Found', [['content-encoding', 'a,b,c,d,e,f']], 'x')), REACH);
  assert.deepEqual(await at(raw('HTTP/1.1 200 OK\r\ncontent-encoding: a,b,c,d,e,f\r\ncontent-length: 4\r\n\r\n'), { method: 'HEAD', path: '/x' }), okWith('HTTP 200\ncontent-type: (none)\n\n'));
  assert.deepEqual(await at(raw('HTTP/1.1 204 No Content\r\ncontent-encoding: a,b,c,d,e,f\r\n\r\n')), okWith('HTTP 204\ncontent-type: (none)\n\n'));
  assert.deepEqual(await at(reply('404 Not Found', [['content-encoding', 'gzip']], zlib.gzipSync('missing'))), okWith('HTTP 404\ncontent-type: (none)\n\nmissing', { exitCode: 1 }));
});

test('the content type: every value joined, latin1, without control characters; a 1xx, a 101 and odd statuses as fetch had them', async (t) => {
  const at = async (answer) => {
    const server = await rawServer(answer);
    t.after(server.close);
    return call(server.port, GET);
  };
  assert.equal((await at(reply('200 OK', [['content-type', 'text/plain'], ['Content-Type', 'text/html']], 'x'))).stdout, 'HTTP 200\ncontent-type: text/plain, text/html\n\nx');
  assert.equal((await at(raw('HTTP/1.1 200 OK\r\ncontent-type: text/\xe9\xff\x80x\r\ncontent-length: 1\r\n\r\nx'))).stdout, 'HTTP 200\ncontent-type: text/\xe9\xffx\n\nx');
  assert.equal((await at(reply('200 OK', [['content-type', '']], 'x'))).stdout, 'HTTP 200\ncontent-type: \n\nx');
  assert.deepEqual(await at(raw('HTTP/1.1 103 Early Hints\r\nlink: </a>\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nafter')), okWith('HTTP 200\ncontent-type: (none)\n\nafter'));
  assert.deepEqual(await at(raw('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nafter')), REACH);
  assert.deepEqual(await at(raw('HTTP/1.1 101 Switching\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\nxx')), REACH);
  assert.deepEqual(await at(raw('HTTP/1.1 101 Switching\r\n\r\n')), REACH);
  assert.deepEqual(await at(raw('HTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nafter')), okWith('HTTP 200\ncontent-type: (none)\n\nafter'));
  // A status below 100 is no usable answer, as fetch failed on it; one above 599 is shown, as fetch showed it.
  for (const status of ['099 Odd', '000 Odd', '000', '042 Odd']) {
    const server = await rawServer(reply(status, [], 'x'));
    t.after(server.close);
    assert.deepEqual(await call(server.port, GET), REACH, status);
    await until(() => server.sockets.size === 0, `the connection of ${status} closed`);
  }
  assert.deepEqual(await at(reply('299 Odd', [], 'x')), okWith('HTTP 299\ncontent-type: (none)\n\nx'));
  assert.deepEqual(await at(reply('600 Odd', [], 'x')), okWith('HTTP 600\ncontent-type: (none)\n\nx', { exitCode: 1 }));
  assert.deepEqual(await at(raw('HTTP/1.1 304 Not Modified\r\ncontent-type: text/plain\r\n\r\n')), {
    exitCode: 1, stdout: 'HTTP 304\ncontent-type: text/plain\n\n', stderr: 'the service answered with a redirect, which is not followed\n',
  });
  assert.deepEqual(await at(rawThenEnd('HTTP/1.0 200 OK\r\n\r\nuntil the end')), okWith('HTTP 200\ncontent-type: (none)\n\nuntil the end'));
  assert.deepEqual(await at(reply('200 OK', [['x-big', 'a'.repeat(17000)]], 'x')), REACH);
  assert.deepEqual(await at(raw('SSH-2.0-OpenSSH_9\r\n\r\n')), REACH);
});

test('the time limit stops a compressed body too, and a stop before the start sends nothing', async (t) => {
  const server = await rawServer((socket) => {
    socket.write(Buffer.from('HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 1000\r\n\r\n', 'latin1'));
    socket.write(zlib.gzipSync('partial', { flush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, 20));
  });
  t.after(server.close);
  const started = Date.now();
  assert.deepEqual(await call(server.port, GET, { timeoutMs: 300 }), {
    exitCode: null, stdout: 'HTTP 200\ncontent-type: (none)\n\npartial', stderr: '', timedOut: true,
  });
  assert.ok(Date.now() - started < 2500);
  await until(() => server.sockets.size === 0, 'the connection closed at the time limit');
  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await call(server.port, GET, { signal: stopped.signal }), {
    exitCode: null, stdout: '', stderr: '', timedOut: true,
  });
  assert.equal(server.requests.length, 1);
});

test('a connect that gives no socket: the time limit still ends the request, and a socket given late is destroyed', async (t) => {
  const server = await rawServer(reply('200 OK', [], 'ok'));
  t.after(server.close);
  const late = [];
  const connect = (options, done) => {
    late.push(done);
    return undefined;
  };
  const started = Date.now();
  assert.deepEqual(await call(server.port, GET, { timeoutMs: 300, connect }), {
    exitCode: null, stdout: '', stderr: '', timedOut: true,
  });
  assert.ok(Date.now() - started < 2500);
  assert.equal(late.length, 1);
  const socket = net.connect(server.port, '127.0.0.1');
  await new Promise((resolve) => { socket.once('connect', resolve); });
  late[0](null, socket);
  await until(() => socket.destroyed && server.sockets.size === 0, 'the late socket destroyed');
  assert.equal(server.requests.length, 0);
  const nothing = await call(server.port, GET, { timeoutMs: 300, connect: () => null });
  assert.equal(nothing.timedOut, true);
});

test('an IPv6 literal host: the Host header keeps its brackets', async (t) => {
  let server;
  try {
    server = await rawServer(reply('200 OK', [], 'v6'), null, '::1');
  } catch {
    t.skip('no IPv6 loopback on this machine');
    return;
  }
  t.after(server.close);
  assert.deepEqual(await send({
    baseUrl: `http://[::1]:${server.port}/`, headers: {}, ...readRequest(GET), timeoutMs: 5000, maxBytes: 100,
  }), okWith('HTTP 200\ncontent-type: (none)\n\nv6'));
  assert.ok(server.requests[0].text.startsWith(`GET /x HTTP/1.1\r\nhost: [::1]:${server.port}\r\n`));
});

test('connect gives the socket the request is sent on: plain, and TLS with the encodings fetch asked for over https', async (t) => {
  const plain = await rawServer(reply('200 OK', [], 'through connect'));
  t.after(plain.close);
  const asked = [];
  const result = await send({
    baseUrl: 'http://service.example.com/',
    headers: {},
    ...readRequest(GET),
    timeoutMs: 5000,
    maxBytes: 100,
    connect: (options) => {
      asked.push(options.host);
      return net.connect(plain.port, '127.0.0.1');
    },
  });
  assert.deepEqual(result, okWith('HTTP 200\ncontent-type: (none)\n\nthrough connect'));
  assert.deepEqual(asked, ['service.example.com']);
  assert.ok(plain.requests[0].text.startsWith('GET /x HTTP/1.1\r\nhost: service.example.com\r\nconnection: close\r\n'));

  const secure = await rawServer(reply('200 OK', [['content-encoding', 'br']], zlib.brotliCompressSync('secure')), { cert, key, ALPNProtocols: ['h2', 'http/1.1'] });
  t.after(secure.close);
  const overTls = await send({
    baseUrl: `https://localhost:${secure.port}/`,
    headers: {},
    ...readRequest(GET),
    timeoutMs: 5000,
    maxBytes: 100,
    connect: (options) => tls.connect({
      host: '127.0.0.1', port: secure.port, servername: options.hostname, ca: cert, ALPNProtocols: options.ALPNProtocols,
    }),
  });
  assert.deepEqual(overTls, okWith('HTTP 200\ncontent-type: (none)\n\nsecure'));
  assert.equal(secure.requests[0].alpn, 'http/1.1');
  assert.equal(secure.requests[0].servername, 'localhost');
  assert.ok(secure.requests[0].text.includes('\r\naccept-encoding: br, gzip, deflate\r\n'));
});

// A child Node with the given environment that sends one GET to baseUrl and prints the result as JSON. The coverage
// folder of the test run, when there is one, is passed on, so that what the child runs is measured too.
function childSend(baseUrl, env, timeoutMs = 5000, maxBytes = 100) {
  const script = `const { readRequest, send } = await import(${JSON.stringify(engine)});
const result = await send({ baseUrl: ${JSON.stringify(baseUrl)}, headers: {}, ...readRequest({ method: 'GET', path: '/x' }), timeoutMs: ${timeoutMs}, maxBytes: ${maxBytes} });
process.stdout.write(JSON.stringify(result));`;
  const coverage = process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE };
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...coverage, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  return new Promise((resolve) => { child.on('close', () => resolve(JSON.parse(out))); });
}

// A child Node with the given environment that sends count GETs to baseUrl, one after the other. After each it prints
// the result as one JSON line and waits for a line on its stdin before the next; it then ends by itself when its stdin
// ends. A socket that outlived send would keep it alive: it then ends with code 3 after 5 seconds. headers are sent as
// they are.
function childCalls(baseUrl, env, count, timeoutMs, headers = {}) {
  const script = `const { createInterface } = await import('node:readline');
const { readRequest, send } = await import(${JSON.stringify(engine)});
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
for (let i = 0; i < ${count}; i += 1) {
  const result = await send({ baseUrl: ${JSON.stringify(baseUrl)}, headers: ${JSON.stringify(headers)}, ...readRequest({ method: 'GET', path: '/x' }), timeoutMs: ${timeoutMs}, maxBytes: 100 });
  process.stdout.write(JSON.stringify(result) + '\\n');
  await lines.next();
}
await lines.next();
setTimeout(() => process.exit(3), 5000).unref();`;
  const coverage = process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE };
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...coverage, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const results = [];
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    const lines = out.split('\n');
    out = lines.pop();
    results.push(...lines.map((line) => JSON.parse(line)));
  });
  const exited = new Promise((resolve) => { child.on('close', (code) => resolve(code)); });
  return { child, results, exited };
}

test('a proxy that refuses CONNECT and keeps the connection, or never answers: no socket outlives send', async (t) => {
  const refusing = await rawServer(raw('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(refusing.close);
  const silent = await rawServer(() => {});
  t.after(silent.close);
  for (const [proxy, timeoutMs, expected] of [[refusing, 5000, REACH], [silent, 300, TIMED_OUT_RESULT]]) {
    const { child, results, exited } = childCalls('https://192.0.2.10/', {
      HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
    }, 3, timeoutMs);
    t.after(() => child.stdin.destroy());
    for (let i = 1; i <= 3; i += 1) {
      await until(() => results.length === i, `call ${i} returned`);
      assert.deepEqual(results[i - 1], expected);
      assert.equal(proxy.requests.length, i);
      assert.ok(proxy.requests[i - 1].text.startsWith('CONNECT 192.0.2.10:443 HTTP/1.1\r\n'));
      await until(() => proxy.sockets.size === 0, `the connection of call ${i} closed while the child runs`);
      assert.equal(child.exitCode, null);
      child.stdin.write('next\n');
    }
    child.stdin.end();
    assert.equal(await exited, 0);
  }
});

test('https: the system CAs and NODE_EXTRA_CA_CERTS are trusted, the host name is checked, ALPN is http/1.1 only', async (t) => {
  const server = await rawServer(reply('200 OK', [['content-type', 'text/plain']], 'secure'), { cert, key, ALPNProtocols: ['h2', 'http/1.1'] });
  t.after(server.close);
  const base = `https://localhost:${server.port}/`;
  assert.deepEqual(await send({
    baseUrl: base, headers: {}, ...readRequest(GET), timeoutMs: 5000, maxBytes: 100,
  }), REACH);
  const caFile = path.join(tempDir('ksproxy-transport-'), 'ca.pem');
  fs.writeFileSync(caFile, cert);
  assert.deepEqual(await childSend(base, { NODE_EXTRA_CA_CERTS: caFile }), okWith('HTTP 200\ncontent-type: text/plain\n\nsecure'));
  const trusted = server.requests.at(-1);
  assert.equal(trusted.alpn, 'http/1.1');
  assert.equal(trusted.servername, 'localhost');
  assert.ok(trusted.text.startsWith(`GET /x HTTP/1.1\r\nhost: localhost:${server.port}\r\nconnection: close\r\n`));
  assert.ok(trusted.text.includes('\r\naccept-encoding: br, gzip, deflate\r\n'));
  assert.deepEqual(await childSend(`https://127.0.0.1:${server.port}/`, { NODE_EXTRA_CA_CERTS: caFile }), REACH);
});

test('a proxy of the environment is used only when Node is told to, as fetch did', async (t) => {
  const proxy = await rawServer(reply('200 OK', [], 'from the proxy'));
  t.after(proxy.close);
  const target = 'http://192.0.2.10:8099/';
  const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '' };
  assert.deepEqual(await childSend(target, { ...env, NODE_USE_ENV_PROXY: '1' }), okWith('HTTP 200\ncontent-type: (none)\n\nfrom the proxy'));
  assert.ok(proxy.requests[0].text.startsWith('GET http://192.0.2.10:8099/x HTTP/1.1\r\nhost: 192.0.2.10:8099\r\n'));
  // Without the word of Node the request goes straight to its target and the proxy sees nothing. The target is a
  // loopback port that nothing listens on, so the test needs no network and ends the same way on every machine.
  const idle = net.createServer();
  await new Promise((resolve) => {
    idle.listen(0, '127.0.0.1', resolve);
  });
  const { port } = idle.address();
  await new Promise((resolve) => {
    idle.close(resolve);
  });
  assert.deepEqual(await childSend(`http://127.0.0.1:${port}/`, env, 3000), REACH);
  assert.equal(proxy.requests.length, 1);
});

// A loopback port that nothing listens on: a request to it goes nowhere, on every machine.
async function closedPort() {
  const idle = net.createServer();
  await new Promise((resolve) => {
    idle.listen(0, '127.0.0.1', resolve);
  });
  const { port } = idle.address();
  await new Promise((resolve) => {
    idle.close(resolve);
  });
  return port;
}

test('widenNoProxy: a bare name also covers its sub-names, as fetch read NO_PROXY', () => {
  assert.equal(widenNoProxy('corp.example.com'), 'corp.example.com,.corp.example.com');
  assert.equal(widenNoProxy('LOCALHOST'), 'LOCALHOST,.LOCALHOST');
  // A name with a port has no form in Node for its sub-names on that port: it stays as written, never all ports.
  assert.equal(widenNoProxy(' a.example , ,b.example:8080 '), 'a.example,.a.example,b.example:8080');
  // A star or a dot before a name with a port covers nothing in Node: the name on that port is added, its sub-names are not.
  assert.equal(widenNoProxy('*.b.example:8080,.c.example:8080,*:8080'), '*.b.example:8080,b.example:8080,.c.example:8080,c.example:8080,*:8080');
  assert.equal(widenNoProxy('192.0.2.10,192.0.2.11:8080,2001:db8::1,::1'), '192.0.2.10,192.0.2.11:8080,2001:db8::1,::1');
  assert.equal(widenNoProxy(''), '');
});

test('widenNoProxy: white space separates entries as a comma does', () => {
  assert.equal(widenNoProxy('a.example b.example\tc.example\n.d.example'), 'a.example,.a.example,b.example,.b.example,c.example,.c.example,.d.example');
  assert.equal(widenNoProxy('a.example, b.example'), 'a.example,.a.example,b.example,.b.example');
});

test('widenNoProxy: a star and a dot cover the name itself too', () => {
  assert.equal(widenNoProxy('.a.example,*.b.example,*'), '.a.example,*.b.example,b.example,*');
  assert.equal(widenNoProxy('*.192.0.2.10'), '*.192.0.2.10,192.0.2.10');
});

test('widenNoProxy: a bracketed IPv6 entry also without its brackets, as Node compares it', () => {
  assert.equal(widenNoProxy('[::1],[2001:db8::1]'), '[::1],::1,[2001:db8::1],2001:db8::1');
  assert.equal(widenNoProxy('[::1]:12345'), '[::1]:12345,::1:12345');
  assert.equal(widenNoProxy('[2001:db8:1:2:3:4:5:6]:8080'), '[2001:db8:1:2:3:4:5:6]:8080,2001:db8:1:2:3:4:5:6:8080');
  // ::1:8080 is also another address, which Node would send direct on every port: the entry stays as written.
  assert.equal(widenNoProxy('[::1]:8080'), '[::1]:8080');
  assert.equal(widenNoProxy('[web1],[::1]x,[::1'), '[web1],[::1]x,[::1');
});

test('widenNoProxy: a value without an entry stays as written, so Node reads it as it read the original', () => {
  for (const value of [' ', ' , ', '\t', ',']) assert.equal(widenNoProxy(value), value, JSON.stringify(value));
});

test('NO_PROXY with a bare name: the name and its sub-names go direct, http and https', async (t) => {
  // The stand-in proxy refuses and closes: a child whose CONNECT was refused on an open connection would wait for it.
  const proxy = await rawServer(rawThenEnd('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(proxy.close);
  const port = await closedPort();
  const proxies = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1' };
  const targets = [`http://web1.localhost:${port}/`, `https://web1.localhost:${port}/`];
  for (const noProxy of [{ NO_PROXY: 'localhost' }, { no_proxy: 'localhost' }, { NO_PROXY: '.localhost' }, { NO_PROXY: '*.localhost' }]) {
    for (const target of targets) {
      assert.deepEqual(await childSend(target, { ...proxies, ...noProxy }, 3000), REACH, `${JSON.stringify(noProxy)} ${target}`);
    }
    assert.equal(proxy.requests.length, 0, JSON.stringify(noProxy));
  }
  for (const target of targets) await childSend(target, { ...proxies, NO_PROXY: 'other.example' }, 3000);
  assert.equal(proxy.requests.length, 2);
});

test('NO_PROXY as fetch read it on the wire: entries split by white space, and a star entry covers the name itself', async (t) => {
  const proxy = await rawServer(rawThenEnd('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(proxy.close);
  const port = await closedPort();
  const proxies = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1' };
  for (const noProxy of ['other.example localhost', 'other.example\tlocalhost', '*.localhost']) {
    for (const target of [`http://localhost:${port}/`, `https://localhost:${port}/`]) {
      assert.deepEqual(await childSend(target, { ...proxies, NO_PROXY: noProxy }, 3000), REACH, `${noProxy} ${target}`);
    }
  }
  assert.equal(proxy.requests.length, 0);
});

test('NO_PROXY [::1]: a target on [::1] goes direct', async (t) => {
  const idle = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      idle.once('error', reject);
      idle.listen(0, '::1', resolve);
    });
  } catch {
    t.skip('no IPv6 loopback on this machine');
    return;
  }
  const { port } = idle.address();
  await new Promise((resolve) => { idle.close(resolve); });
  const proxy = await rawServer(rawThenEnd('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(proxy.close);
  const proxies = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1' };
  assert.deepEqual(await childSend(`http://[::1]:${port}/`, { ...proxies, NO_PROXY: '[::1]' }, 3000), REACH);
  assert.equal(proxy.requests.length, 0);
});

test('a blank no_proxy stays blank: Node does not fall back to NO_PROXY, and the target goes to the proxy', async (t) => {
  const proxy = await rawServer(rawThenEnd('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(proxy.close);
  const port = await closedPort();
  const env = {
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1', no_proxy: ' ', NO_PROXY: 'localhost',
  };
  await childSend(`http://localhost:${port}/`, env, 3000);
  assert.equal(proxy.requests.length, 1);
  assert.ok(proxy.requests[0].text.startsWith(`GET http://localhost:${port}/x HTTP/1.1\r\n`));
});

test('a header name that the transport also sets is sent once, with the credential', async (t) => {
  const server = await rawServer(reply('200 OK', [], 'ok'));
  t.after(server.close);
  const usual = {
    'user-agent': 'node', 'accept-language': '*', 'sec-fetch-mode': 'cors', 'accept-encoding': 'gzip, deflate',
  };
  for (const name of ['User-Agent', 'accept-language', 'Sec-Fetch-Mode', 'Accept-Encoding']) {
    await call(server.port, GET, { headers: authHeader({ headerName: name, headerEnv: 'K' }, { K: 'key-1' }) });
    const { text } = server.requests.at(-1);
    const lower = name.toLowerCase();
    assert.equal(text.split(`\r\n${lower}: key-1\r\n`).length, 2, name);
    assert.equal(text.split(`\r\n${lower}: `).length, 2, name);
    for (const [other, value] of Object.entries(usual)) {
      if (other !== lower) assert.ok(text.includes(`\r\n${other}: ${value}\r\n`), `${name}: ${other}`);
    }
  }
});

test('a proxy with a login: plain http sends proxy-authorization, and its login is hidden in the reply', async (t) => {
  let proxy;
  proxy = await rawServer((socket) => reply('407 Proxy Authentication Required', [], proxy.requests.at(-1).text)(socket));
  t.after(proxy.close);
  const login = Buffer.from('puser:proxy-pass-9').toString('base64');
  const result = await childSend('http://192.0.2.10:8099/', {
    HTTP_PROXY: `http://puser:proxy-pass-9@127.0.0.1:${proxy.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
  }, 5000, 4096);
  assert.ok(proxy.requests[0].text.includes(`\r\nproxy-authorization: Basic ${login}\r\n`));
  assert.equal(result.exitCode, 1);
  for (const piece of ['proxy-pass-9', login]) assert.ok(!result.stdout.includes(piece), piece);
  assert.ok(result.stdout.includes('[hidden]'));
});

test('a proxy login: never the user name alone, always the base64 Node sends, the password from 8 characters on', async (t) => {
  const echo = (text) => rawServer(reply('200 OK', [['content-type', 'application/json']], text));
  const long = Buffer.from('a:longpassword1').toString('base64');
  const first = await echo(`a user, password longpassword1, sent ${long}`);
  t.after(first.close);
  assert.deepEqual(await childSend('http://192.0.2.10:8099/', {
    HTTP_PROXY: `http://a:longpassword1@127.0.0.1:${first.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
  }, 5000, 4096), okWith('HTTP 200\ncontent-type: application/json\n\na user, password [hidden], sent [hidden]'));
  const short = Buffer.from('puser:pw').toString('base64');
  const second = await echo(`puser, pw, sent ${short}`);
  t.after(second.close);
  assert.deepEqual(await childSend('http://192.0.2.10:8099/', {
    HTTP_PROXY: `http://puser:pw@127.0.0.1:${second.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
  }, 5000, 4096), okWith('HTTP 200\ncontent-type: application/json\n\npuser, pw, sent [hidden]'));
});

test('the login of every proxy variable is hidden, percent-decoded, and an address that is not a URL is passed over', async (t) => {
  const login = Buffer.from('pu ser:pass/9word').toString('base64');
  const other = Buffer.from('a:short').toString('base64');
  const proxy = await rawServer(reply('200 OK', [['content-type', `text/${login}`]], `user pu ser, password pass/9word, raw pw%zz-long, other a short ${other}`));
  t.after(proxy.close);
  const result = await childSend('http://192.0.2.10:8099/', {
    http_proxy: `http://pu%20ser:pass%2F9word@127.0.0.1:${proxy.port}`,
    HTTP_PROXY: 'not a url',
    HTTPS_PROXY: 'http://us:pw%zz-long@127.0.0.1:1',
    https_proxy: 'http://a:short@127.0.0.1:1',
    NO_PROXY: '',
    NODE_USE_ENV_PROXY: '1',
  }, 5000, 4096);
  assert.deepEqual(result, okWith('HTTP 200\ncontent-type: text/[hidden]\n\nuser pu ser, password [hidden], raw [hidden], other a short [hidden]'));
});

test('widenNoProxy: a star and a dot give the shorter form only for a plain name', () => {
  for (const entry of ['*.*', '*.*.corp.example', '*..corp.example', '*.', '*.::1']) assert.equal(widenNoProxy(entry), entry, entry);
  for (const entry of ['*.*.corp.example:8080', '.*.corp.example:8080', '*..corp.example:8080', '..corp.example:8080', '.:8080', '*.:8080', '.::1:8080', '*.a:b:8080']) {
    assert.equal(widenNoProxy(entry), entry, entry);
  }
  assert.equal(widenNoProxy('*.corp.example,.corp.example:0443'), '*.corp.example,corp.example,.corp.example:0443,corp.example:0443');
});

test('NO_PROXY .name:port and *.name:port: the name itself on that port goes direct, a sub-name still goes to the proxy', async (t) => {
  const proxy = await rawServer(rawThenEnd('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(proxy.close);
  const port = await closedPort();
  const proxies = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1' };
  for (const noProxy of [`.localhost:${port}`, `*.localhost:${port}`]) {
    assert.deepEqual(await childSend(`http://localhost:${port}/`, { ...proxies, NO_PROXY: noProxy }, 3000), REACH, noProxy);
  }
  assert.equal(proxy.requests.length, 0);
  await childSend(`http://web1.localhost:${port}/`, { ...proxies, NO_PROXY: `.localhost:${port}` }, 3000);
  assert.equal(proxy.requests.length, 1);
});

test('the proxy variables as fetch chose them: a lower-case one that is set counts alone, and https takes the http proxy', async (t) => {
  const proxy = await rawServer(rawThenEnd('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  t.after(proxy.close);
  const port = await closedPort();
  const at = `http://127.0.0.1:${proxy.port}`;
  // An empty http_proxy: no proxy, so a plain http target and its credential do not go to HTTP_PROXY.
  assert.deepEqual(await childSend(`http://localhost:${port}/`, {
    http_proxy: '', HTTP_PROXY: `http://puser:proxy-pass-9@127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: '1',
  }, 3000), REACH);
  assert.equal(proxy.requests.length, 0);
  // An empty no_proxy: no host goes direct, NO_PROXY does not count.
  await childSend(`http://localhost:${port}/`, {
    HTTP_PROXY: at, no_proxy: '', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1',
  }, 3000);
  assert.equal(proxy.requests.length, 1);
  assert.ok(proxy.requests[0].text.startsWith(`GET http://localhost:${port}/x HTTP/1.1\r\n`));
  // No https proxy, or an empty one: an https target goes through the http proxy, with CONNECT.
  for (const env of [{ HTTP_PROXY: at }, { http_proxy: at }, { HTTP_PROXY: at, https_proxy: '' }, { HTTP_PROXY: at, https_proxy: '', HTTPS_PROXY: 'http://127.0.0.1:1' }]) {
    const before = proxy.requests.length;
    assert.deepEqual(await childSend(`https://localhost:${port}/`, { ...env, NODE_USE_ENV_PROXY: '1' }, 3000), REACH, JSON.stringify(env));
    assert.equal(proxy.requests.length, before + 1, JSON.stringify(env));
    assert.ok(proxy.requests.at(-1).text.startsWith(`CONNECT localhost:${port} HTTP/1.1\r\n`));
  }
  // An empty http_proxy gives no proxy for https either.
  assert.deepEqual(await childSend(`https://localhost:${port}/`, { http_proxy: '', HTTP_PROXY: at, NODE_USE_ENV_PROXY: '1' }, 3000), REACH);
  assert.equal(proxy.requests.length, 5);
});

test('a proxy login that is only a user name: the user name is hidden from 8 characters on', async (t) => {
  const echo = (text) => rawServer(reply('200 OK', [['content-type', 'application/json']], text));
  for (const login of ['TOKENabcdef123456', 'TOKENabcdef123456:']) {
    const sent = Buffer.from('TOKENabcdef123456:').toString('base64');
    const server = await echo(`user TOKENabcdef123456, sent ${sent}`);
    t.after(server.close);
    assert.deepEqual(await childSend('http://192.0.2.10:8099/', {
      HTTP_PROXY: `http://${login}@127.0.0.1:${server.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
    }, 5000, 4096), okWith('HTTP 200\ncontent-type: application/json\n\nuser [hidden], sent [hidden]'), login);
  }
  const short = await echo('user tok1234, json');
  t.after(short.close);
  assert.deepEqual(await childSend('http://192.0.2.10:8099/', {
    HTTP_PROXY: `http://tok1234:@127.0.0.1:${short.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
  }, 5000, 4096), okWith('HTTP 200\ncontent-type: application/json\n\nuser tok1234, json'));
});

test('a header that Node refuses when the request ends: the socket is destroyed at once, with or without connect', async (t) => {
  const server = await rawServer(() => {});
  t.after(server.close);
  const made = [];
  const connect = () => {
    const socket = net.connect(server.port, '127.0.0.1');
    made.push(socket);
    return socket;
  };
  assert.deepEqual(await call(server.port, GET, { headers: { trailer: 'x-sum' }, timeoutMs: 30000, connect }), REACH);
  await until(() => made.length === 1 && made[0].destroyed, 'the socket of connect destroyed');
  const { child, results, exited } = childCalls(`http://127.0.0.1:${server.port}/`, {}, 1, 30000, { trailer: 'x-sum' });
  t.after(() => child.stdin.destroy());
  await until(() => results.length === 1, 'the call returned');
  assert.deepEqual(results[0], REACH);
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(server.requests.length, 0);
});
