import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { main } from '../src/cli.js';
import { validateInventory } from '../src/inventory.js';
import esKind from '../src/kinds/elasticsearch/index.js';
import {
  connectOf, readRequest, send, tunnelConnect, urlAddress,
} from '../src/kinds/engines/http.js';
import { openStream, streamArgs } from '../src/kinds/engines/tunnel.js';
import httpKind from '../src/kinds/http/index.js';
import { hostAnswers } from '../src/kinds/http/reach.js';
import mqKind from '../src/kinds/rabbitmq/index.js';
import { ensureDir, socketDir } from '../src/paths.js';
import { callTool } from '../src/tools.js';
import { selfSigned } from './fixtures/self-signed.js';
import {
  alive, cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

// The http kinds through a tunnel: the stream of a fake ssh in stream mode, joined to a loopback server of this file,
// is the socket of each request, plain and over TLS. Unit tests call the hooks of the kinds with a tunnel they build
// from openStream; the start tests run a real start and a real doctor of a target of each kind that has a route.

const key = (name) => ['KSPROXY', name].join('_');
const SSH_KEY = key('SSH');
const STATE_KEY = key('STATE_DIR');
const CONFIG_KEY = key('CONFIG_DIR');
const PORT_KEY = key('FAKE_SSH_STREAM_PORT');
const FAIL_KEY = key('FAKE_SSH_STREAM_FAIL');
const DONE_KEY = key('FAKE_SSH_STREAM_DONE');
const PID_KEY = key('FAKE_SSH_PID_LOG');
const LOG_KEY = key('FAKE_SSH_LOG');
const HEALTH_KEY = key('HEALTH_MS');
const PROJECT_KEY = key('PROJECT');
const TOKEN_VAR = 'HT_TUNNEL_TOKEN';
const TOKEN = 'tk-T7NNEL-41c9-unmistakable';
const USER_VAR = 'HT_TUNNEL_USER';
const USER = 'opsreader';
const PASSWORD_VAR = 'HT_TUNNEL_PASSWORD';
const PASSWORD = 'pw-T7NNEL-77aa-unmistakable';
const fakeSsh = new URL('./fixtures/fake-ssh.js', import.meta.url).pathname;
const engine = new URL('../src/kinds/engines/http.js', import.meta.url).pathname;

const closers = [];
const originalCAs = tls.getCACertificates('default');
after(async () => {
  tls.setDefaultCACertificates(originalCAs);
  for (const close of closers) await close();
  cleanupAll();
});

// A raw server: it keeps each request as it came (the head and the body its content-length gives) with the server
// name and ALPN of a TLS connection, and answers it with answer(socket, text). tlsOptions makes it a TLS server.
async function rawServer(answer, tlsOptions = null) {
  const requests = [];
  const sockets = new Set();
  const onConnection = (socket) => {
    sockets.add(socket);
    let data = Buffer.alloc(0);
    let done = false;
    socket.on('error', () => {});
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
      answer(socket, text);
    });
  };
  const server = tlsOptions === null ? net.createServer(onConnection) : tls.createServer(tlsOptions, onConnection);
  // A TLS connection that fails its handshake is counted, so that a test can wait for the client to have tried.
  const failedHandshakes = [];
  server.on('tlsClientError', () => failedHandshakes.push(true));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
  closers.push(close);
  return {
    port: server.address().port, requests, sockets, failedHandshakes, close,
  };
}

const reply = (status, headers, body = '') => (socket) => {
  const bytes = Buffer.from(body);
  const lines = [...headers, ['content-length', String(bytes.length)]].map(([name, value]) => `${name}: ${value}\r\n`).join('');
  socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 ${status}\r\n${lines}\r\n`, 'latin1'), bytes]));
};
const OK_JSON = reply('200 OK', [['content-type', 'application/json']], '{"status":"green","name":"opsreader"}');

const pidsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const noChildLeft = (file) => waitFor(() => pidsOf(file).every((pid) => !alive(pid)), 10000, 'every stream ssh to end');

// The env of the fake ssh with a socket file that stands for the shared connection, and a tunnel of the shape the core
// gives a kind: { connect }, which makes one stream to the server at port, and keeps them.
function tunnelTo(port, { to = 'web1.example.com:8080', extra = {} } = {}) {
  const dir = tempDir('ksproxy-ht-');
  const env = {
    ...process.env, [SSH_KEY]: fakeSsh, [STATE_KEY]: dir, [PORT_KEY]: String(port), [PID_KEY]: path.join(dir, 'pids'), ...extra,
  };
  ensureDir(socketDir(env));
  const socket = path.join(socketDir(env), 'tnl-test');
  fs.writeFileSync(socket, '');
  const args = streamArgs({ socket, jumps: [], to });
  const made = [];
  const tunnel = Object.freeze({
    connect() {
      const stream = openStream(args, env);
      made.push(stream);
      return stream;
    },
  });
  return { tunnel, made, pids: env[PID_KEY] };
}

// Each made stream is destroyed and its child is gone.
async function allClosed(t) {
  await waitFor(() => t.made.every((s) => s.destroyed), 10000, 'every stream to be destroyed');
  await noChildLeft(t.pids);
}

const httpTarget = (baseUrl) => ({
  kind: 'http', name: 'grafana', baseUrl, auth: { bearerEnv: TOKEN_VAR }, description: '', allow: ['GET /x'],
});
const basicTarget = (kind, baseUrl) => ({
  kind, name: 'svc', baseUrl, auth: { basicUserEnv: USER_VAR, basicPasswordEnv: PASSWORD_VAR }, description: '', allow: 'any',
});
const KINDS = [
  {
    kind: httpKind, target: httpTarget, secrets: { [TOKEN_VAR]: TOKEN }, input: { method: 'GET', path: '/x' }, path: '/api/x',
  },
  {
    kind: esKind, target: (u) => basicTarget('elasticsearch', u), secrets: { [USER_VAR]: USER, [PASSWORD_VAR]: PASSWORD }, input: { method: 'GET', path: '/_cat/indices' }, path: '/api/_cat/indices',
  },
  {
    kind: mqKind, target: (u) => basicTarget('rabbitmq', u), secrets: { [USER_VAR]: USER, [PASSWORD_VAR]: PASSWORD }, input: { method: 'GET', path: '/api/queues/%2F' }, path: '/api/api/queues/%2F',
  },
];
const ctx = (k, extra = {}) => ({
  secrets: k.secrets, timeoutMs: 5000, maxBytes: 262144, signal: new AbortController().signal, input: k.input, ...extra,
});
const ALLOWED = { allowed: true, rule: 'any' };
const REACH = { exitCode: 1, stdout: '', stderr: 'the service could not be reached\n' };
const GOT = {
  exitCode: 0, stdout: 'HTTP 200\ncontent-type: application/json\n\n{"status":"green","name":"opsreader"}', stderr: '', ownStderr: true, truncated: false, cutOff: false,
};
const TIMED_OUT = {
  exitCode: null, stdout: '', stderr: '', timedOut: true,
};

test('tunnelTo: the host and port of the URL, the default port of the scheme, an IPv6 host in brackets; the certificate is checked for https only', () => {
  assert.equal(urlAddress('http://web1.example.com/'), 'web1.example.com:80');
  assert.equal(urlAddress('https://web1.example.com/api/'), 'web1.example.com:443');
  assert.equal(urlAddress('https://web1.example.com:9200/'), 'web1.example.com:9200');
  assert.equal(urlAddress('http://192.0.2.7:8080/'), '192.0.2.7:8080');
  assert.equal(urlAddress('http://[2001:db8::5]:15672/'), '[2001:db8::5]:15672');
  assert.equal(urlAddress('https://[2001:db8::5]/'), '[2001:db8::5]:443');
  // A name that the stream engine cannot take is refused there with its own text, which holds no part of the URL.
  assert.equal(urlAddress('http://web1.example.com./'), 'web1.example.com.:80');
  assert.throws(() => streamArgs({ socket: '/s', jumps: [], to: urlAddress('http://web1.example.com./') }), /^Error: the service address must be host:port or \[IPv6\]:port$/);
  // The engine refuses that form with jumps, where its brackets would be shell characters.
  assert.throws(() => streamArgs({ socket: '/s', jumps: ['ssh ops@192.0.2.10'], to: urlAddress('https://[2001:db8::5]/') }), /an IPv6 service address cannot be used with jumps/);
  // The URL parser has written the host in its one form already: letter case, a number for an address, a name in
  // another script, and a default port written out.
  assert.equal(urlAddress(new URL('HTTP://WEB1.Example.COM:80/').href), 'web1.example.com:80');
  assert.equal(urlAddress(new URL('http://0xc0.0.2.7/').href), '192.0.2.7:80');
  assert.equal(urlAddress(new URL('https://bücher.example/').href), 'xn--bcher-kva.example:443');
  for (const { kind, target } of KINDS) {
    assert.equal(kind.tunnelTo(target('https://es.internal.example.com:9200/')), 'es.internal.example.com:9200', kind.key);
    assert.equal(kind.tunnelTo(target('http://mq.internal.example.com/'), { [PASSWORD_VAR]: PASSWORD }), 'mq.internal.example.com:80', kind.key);
    assert.equal(kind.tunnelListener, undefined, kind.key);
    assert.equal(kind.tunnelProblem, undefined, kind.key);
    assert.equal(kind.tunnelChecksCertificate(target('https://web1.example.com/')), true, kind.key);
    assert.equal(kind.tunnelChecksCertificate(target('http://web1.example.com/')), false, kind.key);
  }
});

test('connectOf: nothing for an entry without a tunnel, so that a target without one connects as before', () => {
  assert.deepEqual(connectOf(undefined), {});
  assert.deepEqual(connectOf({ kind: 'http' }), {});
  assert.equal(typeof connectOf({ tunnel: { connect() {} } }).connect, 'function');
});

test('a call through a tunnel sends what a direct call sends but for the Host header, which names the real host', async () => {
  for (const k of KINDS) {
    const direct = await rawServer(OK_JSON);
    const viaStream = await rawServer(OK_JSON);
    const t = tunnelTo(viaStream.port);
    const plain = await k.kind.perform(k.target(`http://127.0.0.1:${direct.port}/api/`), ALLOWED, ctx(k));
    const tunnelled = await k.kind.perform(k.target('http://web1.example.com:8080/api/'), ALLOWED, ctx(k, { opened: { tunnel: t.tunnel } }));
    assert.deepEqual(plain, GOT, k.kind.key);
    assert.deepEqual(tunnelled, GOT, k.kind.key);
    const [sent] = viaStream.requests;
    assert.ok(sent.text.startsWith(`GET ${k.path} HTTP/1.1\r\nhost: web1.example.com:8080\r\nconnection: close\r\n`), sent.text);
    assert.equal(sent.text, direct.requests[0].text.replace(`host: 127.0.0.1:${direct.port}`, 'host: web1.example.com:8080'), k.kind.key);
    assert.equal(t.made.length, 1);
    await allClosed(t);
    // An opened entry without a tunnel makes no stream.
    assert.deepEqual(await k.kind.perform(k.target(`http://127.0.0.1:${direct.port}/api/`), ALLOWED, ctx(k, { opened: { kind: k.kind.key } })), GOT);
    assert.equal(t.made.length, 1);
    assert.equal(direct.requests[1].text, direct.requests[0].text);
  }
  // The default port is not written in the Host header, as without a tunnel.
  const s = await rawServer(OK_JSON);
  const t = tunnelTo(s.port, { to: 'web1.example.com:80' });
  assert.deepEqual(await httpKind.perform(httpTarget('http://web1.example.com/'), ALLOWED, ctx(KINDS[0], { opened: { tunnel: t.tunnel } })), GOT);
  assert.ok(s.requests[0].text.startsWith('GET /x HTTP/1.1\r\nhost: web1.example.com\r\nconnection: close\r\n'));
  await allClosed(t);
});

test('the doctor of elasticsearch and rabbitmq works on the entry of the trial, { kind, target } and the tunnel', async () => {
  for (const [k, wanted, pathOf] of [[KINDS[1], 'cluster green', '/_cluster/health'], [KINDS[2], 'user', '/api/whoami']]) {
    const s = await rawServer(OK_JSON);
    const t = tunnelTo(s.port);
    const entry = Object.freeze({ kind: k.kind.key, target: k.target('http://web1.example.com:8080/'), tunnel: t.tunnel });
    const verdict = await k.kind.doctor(entry, { secrets: k.secrets, timeoutMs: 5000, signal: new AbortController().signal });
    assert.equal(verdict.ok, true, verdict.detail);
    assert.match(verdict.detail, new RegExp(wanted));
    assert.ok(s.requests[0].text.startsWith(`GET ${pathOf} HTTP/1.1\r\nhost: web1.example.com:8080\r\n`));
    await allClosed(t);
    const direct = await k.kind.doctor({ kind: k.kind.key, target: k.target(`http://127.0.0.1:${s.port}/`) }, { secrets: k.secrets, timeoutMs: 5000, signal: new AbortController().signal });
    assert.equal(direct.ok, true);
    assert.equal(t.made.length, 1);
  }
});

test('https through the tunnel: the certificate is checked against the real name, and nothing is sent to a server that fails it', async () => {
  const good = selfSigned('web1.example.com');
  const other = selfSigned('other.example.com');
  const tlsAt = (pair) => ({ cert: pair.cert, key: pair.key, ALPNProtocols: ['h2', 'http/1.1'] });
  tls.setDefaultCACertificates([good.cert, other.cert]);
  try {
    for (const k of KINDS) {
      const s = await rawServer(OK_JSON, tlsAt(good));
      const t = tunnelTo(s.port, { to: 'web1.example.com:443' });
      assert.deepEqual(await k.kind.perform(k.target('https://web1.example.com/api/'), ALLOWED, ctx(k, { opened: { tunnel: t.tunnel } })), GOT, k.kind.key);
      assert.equal(s.requests[0].servername, 'web1.example.com');
      assert.equal(s.requests[0].alpn, 'http/1.1');
      assert.ok(s.requests[0].text.startsWith(`GET ${k.path} HTTP/1.1\r\nhost: web1.example.com\r\nconnection: close\r\n`));
      assert.ok(s.requests[0].text.includes('\r\naccept-encoding: br, gzip, deflate\r\n'));
      await allClosed(t);

      // A certificate for another name: refused before a byte of the request, so the credential never left.
      const wrong = await rawServer(OK_JSON, tlsAt(other));
      const w = tunnelTo(wrong.port, { to: 'web1.example.com:443' });
      assert.deepEqual(await k.kind.perform(k.target('https://web1.example.com/api/'), ALLOWED, ctx(k, { opened: { tunnel: w.tunnel } })), REACH);
      assert.deepEqual(wrong.requests, []);
      await allClosed(w);
    }

    // An address as the host is checked as an address: no server name is sent, and a certificate for a name fails.
    const byIp = await rawServer(OK_JSON, tlsAt(good));
    const ip = tunnelTo(byIp.port, { to: '192.0.2.7:443' });
    assert.deepEqual(await httpKind.perform(httpTarget('https://192.0.2.7/'), ALLOWED, ctx(KINDS[0], { opened: { tunnel: ip.tunnel } })), REACH);
    assert.deepEqual(byIp.requests, []);
    await waitFor(() => byIp.failedHandshakes.length === 1, 5000, 'the handshake to be tried');
    await allClosed(ip);
  } finally {
    tls.setDefaultCACertificates(originalCAs);
  }

  // An authority this process does not trust: refused, as without a tunnel.
  const unknown = await rawServer(OK_JSON, tlsAt(good));
  const u = tunnelTo(unknown.port, { to: 'web1.example.com:443' });
  assert.deepEqual(await esKind.perform(KINDS[1].target('https://web1.example.com/'), ALLOWED, ctx(KINDS[1], { opened: { tunnel: u.tunnel } })), REACH);
  assert.deepEqual(unknown.requests, []);
  await allClosed(u);
});

test('the server name of tunnelConnect is the host of the request, never sent for an address', () => {
  const seen = [];
  const fakeStream = { destroy() {} };
  const connect = tunnelConnect({ connect: () => fakeStream });
  // Plain http: the stream itself.
  assert.equal(connect({ protocol: 'http:', hostname: 'web1.example.com', ALPNProtocols: ['http/1.1'] }), fakeStream);
  const real = tls.connect;
  tls.connect = (options) => {
    seen.push(options);
    return 'secure';
  };
  try {
    assert.equal(connect({ protocol: 'https:', hostname: 'web1.example.com', ALPNProtocols: ['http/1.1'] }), 'secure');
    connect({ protocol: 'https:', hostname: '2001:db8::5', ALPNProtocols: ['http/1.1'] });
  } finally {
    tls.connect = real;
  }
  assert.deepEqual(seen, [
    {
      host: 'web1.example.com', servername: 'web1.example.com', ALPNProtocols: ['http/1.1'], socket: fakeStream,
    },
    {
      host: '2001:db8::5', servername: undefined, ALPNProtocols: ['http/1.1'], socket: fakeStream,
    },
  ]);
});

test('connect() that throws is a clean failed call and a failed check, with no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const message of ['the shared connection is not open', 'at most 8 connections with jumps may be open at once over one shared connection']) {
      const throwing = { connect() { throw new Error(message); } };
      for (const k of KINDS) {
        for (const baseUrl of ['http://web1.example.com/', 'https://web1.example.com/']) {
          assert.deepEqual(await k.kind.perform(k.target(baseUrl), ALLOWED, ctx(k, { opened: { tunnel: throwing } })), REACH, `${k.kind.key} ${baseUrl}`);
          const verdict = await k.kind.doctor({ kind: k.kind.key, target: k.target(baseUrl), tunnel: throwing }, { secrets: k.secrets, timeoutMs: 5000, signal: new AbortController().signal });
          assert.equal(verdict.ok, false);
        }
      }
    }
    const verdict = await httpKind.doctor({ kind: 'http', target: httpTarget('https://web1.example.com/'), tunnel: { connect() { throw new Error('x'); } } }, { timeoutMs: 5000 });
    assert.deepEqual(verdict, { ok: false, detail: 'no connection from port 443 through the tunnel (error)' });
    await new Promise((resolve) => { setImmediate(resolve); });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('a header that cannot be sent makes no stream, or one that is destroyed at once', async () => {
  const s = await rawServer(OK_JSON);
  const t = tunnelTo(s.port);
  assert.deepEqual(await send({
    baseUrl: 'http://web1.example.com:8080/', headers: { authorization: 'Bearer a\nb' }, ...readRequest({ method: 'GET', path: '/x' }), timeoutMs: 5000, maxBytes: 100, connect: tunnelConnect(t.tunnel),
  }), REACH);
  assert.equal(t.made.length, 0);
  assert.deepEqual(s.requests, []);
});

test('a stream that ends early or fails ends the call at once with the fixed text, plain and with TLS, and no child is left', async () => {
  const s = await rawServer(OK_JSON);
  const k = KINDS[1];
  for (const baseUrl of ['http://web1.example.com:8080/', 'https://web1.example.com:8080/']) {
    for (const extra of [{ [DONE_KEY]: '' }, { [DONE_KEY]: 'not http at all\r\n\r\n' }, { [FAIL_KEY]: '0' }, { [FAIL_KEY]: 'quiet' }]) {
      const t = tunnelTo(s.port, { extra });
      const started = Date.now();
      assert.deepEqual(await k.kind.perform(k.target(baseUrl), ALLOWED, ctx(k, { opened: { tunnel: t.tunnel } })), REACH, `${baseUrl} ${JSON.stringify(extra)}`);
      assert.ok(Date.now() - started < 4000);
      await allClosed(t);
    }
  }
  assert.deepEqual(s.requests, []);
});

test('a reply that breaks, a redirect and the read limit destroy the stream and leave no child', async () => {
  const k = KINDS[0];
  const broken = await rawServer((socket) => socket.end(Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial', 'latin1')));
  const b = tunnelTo(broken.port);
  assert.deepEqual(await k.kind.perform(k.target('http://web1.example.com:8080/'), ALLOWED, ctx(k, { opened: { tunnel: b.tunnel } })), {
    exitCode: 1, stdout: 'HTTP 200\ncontent-type: (none)\n\npartial', stderr: 'the reply was cut off\n', ownStderr: true, truncated: false, cutOff: true,
  });
  await allClosed(b);

  const moved = await rawServer(reply('302 Found', [['location', 'http://other.example.com/']], 'moved'));
  const m = tunnelTo(moved.port);
  assert.deepEqual(await k.kind.perform(k.target('http://web1.example.com:8080/'), ALLOWED, ctx(k, { opened: { tunnel: m.tunnel } })), {
    exitCode: 1, stdout: 'HTTP 302\ncontent-type: (none)\n\n', stderr: 'the service answered with a redirect, which is not followed\n',
  });
  assert.equal(moved.requests.length, 1);
  await allClosed(m);

  // A body far longer than the limit, which the server keeps writing: the read stops at the limit.
  const big = await rawServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\ncontent-length: 10000000\r\n\r\n');
    const more = () => {
      while (!socket.destroyed && socket.write(Buffer.alloc(65536, 0x61)));
      if (!socket.destroyed) socket.once('drain', more);
    };
    more();
  });
  const l = tunnelTo(big.port);
  const limited = await k.kind.perform(k.target('http://web1.example.com:8080/'), ALLOWED, ctx(k, { maxBytes: 1000, opened: { tunnel: l.tunnel } }));
  assert.equal(limited.truncated, true);
  assert.equal(limited.stdout, `HTTP 200\ncontent-type: (none)\n\n${'a'.repeat(1000)}`);
  await allClosed(l);
});

test('the time limit and the stop signal destroy the stream and leave no child, plain and with TLS', async () => {
  const k = KINDS[2];
  const quiet = await rawServer(() => {});
  const t = tunnelTo(quiet.port);
  const started = Date.now();
  assert.deepEqual(await k.kind.perform(k.target('http://web1.example.com:8080/'), ALLOWED, ctx(k, { timeoutMs: 300, opened: { tunnel: t.tunnel } })), TIMED_OUT);
  assert.ok(Date.now() - started < 3000);
  await allClosed(t);

  const good = selfSigned('web1.example.com');
  const secure = await rawServer(() => {}, { cert: good.cert, key: good.key });
  tls.setDefaultCACertificates([good.cert]);
  try {
    const st = tunnelTo(secure.port);
    const stopper = new AbortController();
    const running = k.kind.perform(k.target('https://web1.example.com:8080/'), ALLOWED, ctx(k, { signal: stopper.signal, opened: { tunnel: st.tunnel } }));
    await waitFor(() => secure.requests.length > 0, 10000, 'the request to reach the server through TLS');
    stopper.abort();
    assert.deepEqual(await running, TIMED_OUT);
    await allClosed(st);

    // The time limit in the middle of a body over TLS.
    const slow = await rawServer((socket) => socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nstart'), { cert: good.cert, key: good.key });
    const sl = tunnelTo(slow.port);
    assert.deepEqual(await k.kind.perform(k.target('https://web1.example.com:8080/'), ALLOWED, ctx(k, { timeoutMs: 500, opened: { tunnel: sl.tunnel } })), {
      exitCode: null, stdout: 'HTTP 200\ncontent-type: (none)\n\nstart', stderr: '', timedOut: true,
    });
    await allClosed(sl);
  } finally {
    tls.setDefaultCACertificates(originalCAs);
  }

  const late = tunnelTo(quiet.port);
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await k.kind.perform(k.target('http://web1.example.com:8080/'), ALLOWED, ctx(k, { signal: already.signal, opened: { tunnel: late.tunnel } })), TIMED_OUT);
  assert.equal(late.made.length, 0, 'a stop before the request makes no stream');
});

test('the http doctor through a tunnel: OPTIONS * over plain http, the handshake over https, and each way it fails', async () => {
  const opts = { timeoutMs: 5000, signal: new AbortController().signal };
  const asked = await rawServer(reply('405 Method Not Allowed', [], ''));
  const a = tunnelTo(asked.port);
  const entry = (baseUrl, tunnel) => Object.freeze({ kind: 'http', target: httpTarget(baseUrl), tunnel });
  assert.deepEqual(await httpKind.doctor(entry('http://web1.example.com:8080/api/', a.tunnel), opts), { ok: true, detail: 'host answers' });
  assert.deepEqual(asked.requests.map((r) => r.text), ['OPTIONS * HTTP/1.1\r\nhost: web1.example.com:8080\r\nconnection: close\r\n\r\n']);
  await allClosed(a);

  const notHttp = await rawServer((socket) => socket.write('SSH-2.0-OpenSSH_9.6\r\n'));
  const n = tunnelTo(notHttp.port);
  assert.deepEqual(await httpKind.doctor(entry('http://web1.example.com/', n.tunnel), opts), { ok: false, detail: 'no HTTP answer from port 80 through the tunnel (not HTTP)' });
  await allClosed(n);
  const closes = await rawServer((socket) => socket.end());
  const c = tunnelTo(closes.port);
  assert.deepEqual(await httpKind.doctor(entry('http://web1.example.com/', c.tunnel), opts), { ok: false, detail: 'no HTTP answer from port 80 through the tunnel (closed)' });
  await allClosed(c);
  // A reply that comes in pieces of a byte is read until the status line is whole.
  const slowly = await rawServer((socket) => {
    socket.setNoDelay(true);
    const bytes = [...'HTTP/1.1 200 OK\r\n\r\n'];
    const next = () => { if (bytes.length > 0 && !socket.destroyed) socket.write(bytes.shift(), () => setTimeout(next, 5)); };
    next();
  });
  const sw = tunnelTo(slowly.port);
  assert.deepEqual(await httpKind.doctor(entry('http://web1.example.com/', sw.tunnel), opts), { ok: true, detail: 'host answers' });
  await allClosed(sw);
  const failing = tunnelTo(asked.port, { extra: { [FAIL_KEY]: '0' } });
  // The child's stdout ends as it fails: the end or the error, whichever comes first.
  assert.match((await httpKind.doctor(entry('http://web1.example.com/', failing.tunnel), opts)).detail, /^no HTTP answer from port 80 through the tunnel \((closed|error)\)$/);
  await allClosed(failing);

  const quiet = await rawServer(() => {});
  const q = tunnelTo(quiet.port);
  assert.deepEqual(await hostAnswers(new URL('http://web1.example.com/'), { timeoutMs: 300, tunnel: q.tunnel }), {
    ok: false, detail: 'no answer on port 80 in time, or the check was stopped',
  });
  await allClosed(q);
  const stopped = new AbortController();
  stopped.abort();
  const none = tunnelTo(quiet.port);
  assert.equal((await hostAnswers(new URL('http://web1.example.com/'), { signal: stopped.signal, tunnel: none.tunnel })).ok, false);
  assert.equal(none.made.length, 0);

  const good = selfSigned('web1.example.com');
  const other = selfSigned('other.example.com');
  const secure = await rawServer(() => {}, { cert: good.cert, key: good.key });
  const s = tunnelTo(secure.port);
  assert.deepEqual(await hostAnswers(new URL('https://web1.example.com/'), { tunnel: s.tunnel }, { ca: good.cert }), { ok: true, detail: 'host answers' });
  await allClosed(s);
  const wrong = await rawServer(() => {}, { cert: other.cert, key: other.key });
  const w = tunnelTo(wrong.port);
  assert.deepEqual(await hostAnswers(new URL('https://web1.example.com/'), { tunnel: w.tunnel }, { ca: [good.cert, other.cert] }), {
    ok: false, detail: 'no TLS answer from port 443 through the tunnel (ERR_TLS_CERT_ALTNAME_INVALID)',
  });
  await allClosed(w);
  const ip = tunnelTo(secure.port, { to: '192.0.2.7:443' });
  assert.deepEqual(await hostAnswers(new URL('https://192.0.2.7/'), { tunnel: ip.tunnel }, { ca: good.cert }), {
    ok: false, detail: 'no TLS answer from port 443 through the tunnel (ERR_TLS_CERT_ALTNAME_INVALID)',
  });
  await allClosed(ip);
  const untrusted = tunnelTo(secure.port);
  const result = await httpKind.doctor(entry('https://web1.example.com/', untrusted.tunnel), opts);
  assert.equal(result.ok, false);
  assert.match(result.detail, /^no TLS answer from port 443 through the tunnel \([A-Z_]+\)$/);
  await allClosed(untrusted);
  const ended = tunnelTo(secure.port, { extra: { [DONE_KEY]: '' } });
  assert.match((await httpKind.doctor(entry('https://web1.example.com/', ended.tunnel), opts)).detail, /^no TLS answer from port 443 through the tunnel \(/);
  await allClosed(ended);
  assert.deepEqual(secure.requests, []);
});

// A child Node with the given environment that sends one GET through tunnelConnect, whose tunnel's stream is a plain
// TCP connection to port, and prints the result as JSON.
function childThroughTunnel(port, env) {
  const script = `import net from 'node:net';
const { readRequest, send, tunnelConnect } = await import(${JSON.stringify(engine)});
const connect = tunnelConnect({ connect: () => net.connect(${port}, '127.0.0.1') });
const result = await send({ baseUrl: 'http://192.0.2.10:8099/', headers: {}, ...readRequest({ method: 'GET', path: '/x' }), timeoutMs: 5000, maxBytes: 100, connect });
process.stdout.write(JSON.stringify(result));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  return new Promise((resolve) => { child.on('close', () => resolve(JSON.parse(out))); });
}

test('a proxy of the environment is never used through a tunnel, even when Node is told to use one', async () => {
  const proxy = await rawServer(reply('200 OK', [], 'from the proxy'));
  const service = await rawServer(reply('200 OK', [], 'from the service'));
  const result = await childThroughTunnel(service.port, {
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1',
  });
  assert.equal(result.stdout, 'HTTP 200\ncontent-type: (none)\n\nfrom the service');
  assert.deepEqual(proxy.requests, []);
  assert.ok(service.requests[0].text.startsWith('GET /x HTTP/1.1\r\nhost: 192.0.2.10:8099\r\n'));
});

// The one service of the start tests: it answers every request with JSON that names the user of basic auth, and for
// the token target echoes the token, which the core must hide; it keeps each request.
async function service() {
  return rawServer((socket, text) => {
    const echo = text.includes(TOKEN) ? `{"token":"${TOKEN}"}` : '{"status":"green","name":"opsreader"}';
    reply('200 OK', [['content-type', 'application/json']], echo)(socket);
  });
}

async function httpWorld(s, entries, extraEnv = {}) {
  const w = await makeWorld({
    extraEnv: {
      [TOKEN_VAR]: TOKEN, [USER_VAR]: USER, [PASSWORD_VAR]: PASSWORD, [PORT_KEY]: String(s.port), [HEALTH_KEY]: '600000', NO_COLOR: '1', ...extraEnv,
    },
  });
  w.env[LOG_KEY] = path.join(w.base, 'calls.log');
  w.env[PID_KEY] = path.join(w.base, 'pids');
  const file = path.join(w.env[CONFIG_KEY], 'inventory.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, ...entries }));
  return w;
}
const JUMP = 'ssh -i .ssh/app_key opsuser@192.0.2.10';
const ROUTE_PARTS = ['bastion1', 'app_key', 'opsuser', '192.0.2.10'];
const ROUTE = { host: 'bastion1', jumps: [JUMP] };
const entriesWith = (tunnel) => ({
  http: [{
    name: 'grafana', baseUrl: 'http://grafana.internal.example.com:3000/', auth: { bearerEnv: TOKEN_VAR }, allow: ['GET /api/search'], tunnel,
  }],
  elasticsearch: [{
    name: 'es-logs', url: 'http://es.internal.example.com:9200', userEnv: USER_VAR, passwordEnv: PASSWORD_VAR, allow: ['GET /_cat/...'], tunnel,
  }],
  rabbitmq: [{
    name: 'mq-prod', url: 'http://mq.internal.example.com:15672', userEnv: USER_VAR, passwordEnv: PASSWORD_VAR, allow: ['GET /api/queues/...'], tunnel,
  }],
});

test('a real start of a tunnelled target of each kind: the trial, then calls; nothing of the route in a file, a list or an answer', async () => {
  const s = await service();
  const w = await httpWorld(s, entriesWith(ROUTE));
  const run = launch(w, { http: ['grafana'], es: ['es-logs'], mq: ['mq-prod'] });
  await ready(run);
  try {
    // The trials: OPTIONS * for http, the fixed GET of elasticsearch and of rabbitmq, each with the real host.
    const heads = s.requests.map((r) => r.text.split('\r\n').slice(0, 2).join(' '));
    assert.deepEqual(heads.sort(), [
      'GET /_cluster/health HTTP/1.1 host: es.internal.example.com:9200',
      'GET /api/whoami HTTP/1.1 host: mq.internal.example.com:15672',
      'OPTIONS * HTTP/1.1 host: grafana.internal.example.com:3000',
    ]);
    const err = run.proc.stderr.text;
    assert.match(err, /http +grafana +OPENING +http:\/\/grafana\.internal\.example\.com:3000\/, bearer token from HT_TUNNEL_TOKEN, through bastion1, then 1 jump$/m);
    assert.match(err, /es +es-logs +OPENING +http:\/\/es\.internal\.example\.com:9200\/, basic auth from HT_TUNNEL_USER and HT_TUNNEL_PASSWORD, through bastion1, then 1 jump$/m);
    assert.match(err, /mq +mq-prod +OPENING .*, through bastion1, then 1 jump$/m);
    assert.equal((err.match(/the servers on the route can read and change the traffic/g) ?? []).length, 3);
    for (const name of ['grafana', 'es-logs', 'mq-prod']) assert.match(err, new RegExp(`${name} +UP`));

    const agentEnv = { ...w.env };
    for (const name of [TOKEN_VAR, USER_VAR, PASSWORD_VAR]) delete agentEnv[name];
    const before = s.requests.length;
    const answers = [
      await callTool('http_request', { target: 'grafana', method: 'GET', path: '/api/search' }, agentEnv),
      await callTool('elasticsearch_request', { target: 'es-logs', method: 'GET', path: '/_cat/indices' }, agentEnv),
      await callTool('rabbitmq_request', { target: 'mq-prod', method: 'GET', path: '/api/queues/%2F' }, agentEnv),
    ];
    assert.deepEqual(answers[0], { text: 'exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n{"token":"[hidden]"}', isError: false });
    // The user name of basic auth is held as a secret too, so the core hides it in the answer.
    assert.deepEqual(answers[1], { text: 'exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n{"status":"green","name":"[hidden]"}', isError: false });
    assert.equal(answers[2].isError, false);
    const calls = s.requests.slice(before).map((r) => r.text);
    assert.ok(calls[0].startsWith(`GET /api/search HTTP/1.1\r\nhost: grafana.internal.example.com:3000\r\nconnection: close\r\nauthorization: Bearer ${TOKEN}\r\n`));
    const basic = Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
    assert.ok(calls[1].startsWith(`GET /_cat/indices HTTP/1.1\r\nhost: es.internal.example.com:9200\r\nconnection: close\r\nauthorization: Basic ${basic}\r\n`));
    assert.ok(calls[2].startsWith(`GET /api/queues/%2F HTTP/1.1\r\nhost: mq.internal.example.com:15672\r\nconnection: close\r\nauthorization: Basic ${basic}\r\n`));

    const texts = [...answers.map((a) => a.text), (await callTool('list_targets', {}, agentEnv)).text];
    for (const file of [path.join(w.sessionDir, 'session.json'), path.join(w.sessionDir, 'AGENT.md')]) texts.push(fs.readFileSync(file, 'utf8'));
    const entries = fs.readFileSync(w.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'call');
    assert.equal(entries.length, 3);
    texts.push(JSON.stringify(entries));
    for (const text of texts) {
      for (const part of ROUTE_PARTS) assert.ok(!text.includes(part), `${part} must not appear`);
      for (const secret of [TOKEN, PASSWORD, USER, basic]) assert.ok(!text.includes(secret));
    }
    const session = JSON.parse(fs.readFileSync(path.join(w.sessionDir, 'session.json'), 'utf8'));
    for (const t of session.targets.filter((x) => ['http', 'elasticsearch', 'rabbitmq'].includes(x.kind))) {
      assert.deepEqual(Object.keys(t).sort(), ['allow', 'auth', 'baseUrl', 'description', 'kind', 'name', 'state'], t.name);
    }
  } finally {
    await stopWith(run);
  }
  await noChildLeft(w.env[PID_KEY]);
});

test('a trial that fails skips the target with the layer: the route, or the service', async () => {
  const s = await service();
  const w = await httpWorld(s, entriesWith(ROUTE), { [FAIL_KEY]: '0' });
  const run = launch(w, { http: ['grafana'], es: ['es-logs'] });
  await waitFor(() => /grafana +SKIPPED/.test(run.proc.stderr.text) && /es-logs +SKIPPED/.test(run.proc.stderr.text), 20000, 'both targets to be skipped');
  await stopWith(run);
  assert.match(run.proc.stderr.text, /grafana +SKIPPED +the route failed: channel 0: open failed: connect failed: Connection refused$/m);
  assert.match(run.proc.stderr.text, /es-logs +SKIPPED +the route failed: channel 0: open failed: connect failed: Connection refused$/m);
  assert.deepEqual(s.requests, []);
  await noChildLeft(w.env[PID_KEY]);

  const notHttp = await rawServer((socket) => socket.end('SSH-2.0-OpenSSH_9.6\r\n'));
  const w2 = await httpWorld(notHttp, entriesWith({ host: 'bastion1' }));
  const run2 = launch(w2, { http: ['grafana'] });
  await waitFor(() => /grafana +SKIPPED/.test(run2.proc.stderr.text), 20000, 'the target to be skipped');
  await stopWith(run2);
  assert.match(run2.proc.stderr.text, /grafana +SKIPPED +the service did not answer through the tunnel: no HTTP answer from port 3000 through the tunnel \(not HTTP\)$/m);
  await noChildLeft(w2.env[PID_KEY]);
});

test('ksproxy doctor on a tunnelled target of each kind passes', async () => {
  const s = await service();
  const w = await httpWorld(s, {});
  delete w.env[PROJECT_KEY];
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'shop.json'), JSON.stringify(entriesWith({ host: 'bastion1' })));
  const proc = fakeProcess();
  const code = await main(['doctor', '--project', 'shop', '--http', 'grafana', '--es', 'es-logs', '--mq', 'mq-prod'], w.env, { process: proc });
  assert.equal(code, 0, proc.stdout.text);
  assert.match(proc.stdout.text, /http +grafana +OK +host answers/m);
  assert.match(proc.stdout.text, /es +es-logs +OK/m);
  assert.match(proc.stdout.text, /mq +mq-prod +OK/m);
  await noChildLeft(w.env[PID_KEY]);
});

test('secrets and hidden forms are the same with a tunnel and without one', () => {
  const secretsOf = { http: { [TOKEN_VAR]: TOKEN }, elasticsearch: { [USER_VAR]: USER, [PASSWORD_VAR]: PASSWORD }, rabbitmq: { [USER_VAR]: USER, [PASSWORD_VAR]: PASSWORD } };
  const raw = entriesWith(undefined);
  const without = validateInventory(raw);
  const withRoute = validateInventory(entriesWith(ROUTE));
  for (const k of KINDS) {
    const [plain] = without[k.kind.key];
    const [routed] = withRoute[k.kind.key];
    assert.deepEqual(routed, plain, k.kind.key);
    assert.deepEqual(k.kind.secrets(routed), k.kind.secrets(plain));
    assert.deepEqual(k.kind.hiddenForms(routed, secretsOf[k.kind.key]), k.kind.hiddenForms(plain, secretsOf[k.kind.key]));
    assert.ok(!JSON.stringify(routed).includes('bastion1'));
  }
});
