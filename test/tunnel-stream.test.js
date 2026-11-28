import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  MAX_JUMP_CONNECTIONS, MAX_LISTENER_CONNECTIONS, STDERR_CAP, openListener, openStream, sharedMasters, streamArgs,
} from '../src/kinds/engines/tunnel.js';
import { ensureDir, socketDir } from '../src/paths.js';
import { tempDir } from './temp.js';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
// The names of the fake's settings, built from parts.
const key = (name) => ['KSPROXY', name].join('_');
const SSH_KEY = key('SSH');
const STATE_KEY = key('STATE_DIR');
const PORT_KEY = key('FAKE_SSH_STREAM_PORT');
const FAIL_KEY = key('FAKE_SSH_STREAM_FAIL');
const LINGER_KEY = key('FAKE_SSH_STREAM_LINGER');
const DONE_KEY = key('FAKE_SSH_STREAM_DONE');
const COMMAND_KEY = key('FAKE_SSH_STREAM_COMMAND');
const PID_KEY = key('FAKE_SSH_PID_LOG');
const LOG_KEY = key('FAKE_SSH_LOG');

// Waits for a real condition, with a deadline.
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A loopback server of the test. handler gets each socket; the server counts the open ones.
async function service(handler) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    handler(s);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    sockets,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const echo = () => service((s) => s.pipe(s));
// A service that never answers, and ends its side when the other side ends, as a database does.
const quiet = () => service((s) => {
  s.resume();
  s.on('end', () => s.end());
});

// A folder with a socket file, as a shared connection that the fake opened, and the env of the fake.
function setup(port, extra = {}) {
  const dir = tempDir('ksproxy-tnl-');
  const env = {
    ...process.env, [SSH_KEY]: fakeSsh, [STATE_KEY]: dir, [PORT_KEY]: String(port), [PID_KEY]: path.join(dir, 'pids'), ...extra,
  };
  ensureDir(socketDir(env));
  const socket = path.join(socketDir(env), 'tnl-test');
  fs.writeFileSync(socket, '');
  return { dir, env, socket };
}

const pids = (env) => (fs.existsSync(env[PID_KEY]) ? fs.readFileSync(env[PID_KEY], 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);

function collect(s) {
  const chunks = [];
  s.on('data', (c) => chunks.push(Buffer.from(c)));
  return new Promise((resolve, reject) => {
    s.once('end', () => resolve(Buffer.concat(chunks)));
    s.once('error', reject);
  });
}

const closed = (s) => new Promise((resolve) => {
  if (s.closed) resolve();
  else s.once('close', resolve);
});

function client(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => resolve(s));
    s.once('error', reject);
  });
}

test('openStream: 1 MiB of random bytes pass both ways unchanged, with jumps, and the fake checked every argument', async () => {
  const server = await echo();
  const jumps = ['ssh -i .ssh/k1 u1@192.0.2.10', 'ssh -o Port=2222 u2@192.0.2.20'];
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps, to: '10.0.0.5:5432' });
  const s = openStream(args, { ...env, [COMMAND_KEY]: args.at(-1) });
  const connected = new Promise((resolve) => {
    s.once('connect', resolve);
  });
  const data = randomBytes(1024 * 1024);
  const got = collect(s);
  s.end(data);
  await connected;
  assert.ok((await got).equals(data));
  await closed(s);
  assert.equal(s.reason, null);
  assert.deepEqual(await s.exited, { reason: null });
  server.close();
});

test('openStream: a reader that is slow holds the child back, and loses nothing', async () => {
  const server = await echo();
  const { env, socket } = setup(server.port);
  const s = openStream(streamArgs({ socket, jumps: [], to: 'db:1' }), env);
  const data = randomBytes(1024 * 1024);
  s.end(data);
  // Nobody reads yet: the buffer of the stream fills, and the output of the child is paused.
  await until(() => s.readableLength >= s.readableHighWaterMark, 'a full buffer');
  assert.ok((await collect(s)).equals(data));
  await closed(s);
  assert.equal(s.reason, null);
  server.close();
});

test('openStream: half close passes both ways, without jumps', async () => {
  const server = await service((sock) => {
    let seen = '';
    sock.setEncoding('utf8');
    sock.write('hello ');
    sock.on('data', (c) => {
      seen += c;
    });
    sock.on('end', () => sock.end(`got ${seen}`));
  });
  const { env, socket } = setup(server.port);
  const s = openStream(streamArgs({ socket, jumps: [], to: '127.0.0.1:1' }), env);
  s.setEncoding('utf8');
  const first = await new Promise((resolve) => {
    s.once('data', resolve);
  });
  assert.equal(first, 'hello ');
  const rest = collect(s);
  s.write('ab');
  s.end('c');
  assert.equal((await rest).toString(), 'got abc');
  await closed(s);
  server.close();
});

test('openStream: the other side ends first, and what is written after that still arrives', async () => {
  let heard;
  const heardIt = new Promise((resolve) => {
    heard = resolve;
  });
  const server = await service((sock) => {
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      heard(Buffer.concat(chunks).toString());
      sock.end();
    });
    sock.end('bye');
  });
  const { env, socket } = setup(server.port);
  const s = openStream(streamArgs({ socket, jumps: [], to: 'db:1' }), env);
  assert.equal((await collect(s)).toString(), 'bye');
  s.end('late words');
  assert.equal(await heardIt, 'late words');
  await closed(s);
  server.close();
});

test('openStream: a child that fails gives its stderr as the reason, capped, and is never blocked by it', async () => {
  const { env, socket } = setup(1, { [FAIL_KEY]: String(200000) });
  const s = openStream(streamArgs({ socket, jumps: ['ssh h'], to: 'db:1' }), env);
  const err = await new Promise((resolve) => {
    s.once('error', resolve);
  });
  assert.ok(err.message.startsWith('channel 0: open failed: connect failed: Connection refused\nxxx'));
  assert.ok(Buffer.byteLength(err.message) <= STDERR_CAP);
  assert.ok(Buffer.byteLength(err.message) > STDERR_CAP - 100);
  assert.equal(STDERR_CAP, 4096);
  assert.equal(s.reason, err.message);
  assert.deepEqual(await s.exited, { reason: err.message });
  await closed(s);
});

test('openStream: a child that fails without a word, by a signal, or that cannot start, says so', async () => {
  const server = await quiet();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  const reasonOf = async (s) => new Promise((resolve) => {
    s.once('error', (err) => resolve(err.message));
  });

  const signalled = openStream(args, env);
  const why = reasonOf(signalled);
  await until(() => pids(env).length === 1 && server.sockets.size === 1, 'the child');
  process.kill(pids(env)[0], 'SIGTERM');
  assert.equal(await why, 'ssh ended with signal SIGTERM');

  assert.equal(await reasonOf(openStream(args, { ...env, [FAIL_KEY]: 'quiet' })), 'ssh exited with code 255');

  const missing = await reasonOf(openStream(args, { ...env, [SSH_KEY]: path.join(env[STATE_KEY], 'no-such-ssh') }));
  assert.match(missing, /ENOENT/);

  // Destroyed before it is known that the program cannot start: there is no child to kill, and close still comes.
  const never = openStream(args, { ...env, [SSH_KEY]: path.join(env[STATE_KEY], 'no-such-ssh') });
  never.destroy();
  await closed(never);
  assert.equal(never.reason, null);

  fs.rmSync(socket);
  const gone = await reasonOf(openStream(args, env));
  assert.match(gone, /^Control socket connect\(.*\): No such file or directory\nkex_exchange_identification/);
  server.close();
});

test('openStream: after a child that ended well, what is written is dropped and the stream ends when its user ends it', async () => {
  const { env, socket } = setup(1, { [DONE_KEY]: 'all done' });
  const s = openStream(streamArgs({ socket, jumps: [], to: 'db:1' }), env);
  const out = collect(s);
  assert.deepEqual(await s.exited, { reason: null });
  assert.equal((await out).toString(), 'all done');
  await new Promise((resolve, reject) => {
    s.write('nobody reads this', (err) => (err ? reject(err) : resolve()));
  });
  assert.equal(s.closed, false);
  s.end();
  await closed(s);
  assert.equal(s.reason, null);
});

test('openStream: destroying the stream kills the child at once, and close comes after it is gone', async () => {
  const server = await quiet();
  const { env, socket } = setup(server.port);
  const s = openStream(streamArgs({ socket, jumps: [], to: 'db:1' }), env);
  await until(() => pids(env).length === 1 && server.sockets.size === 1, 'the child');
  const [pid] = pids(env);
  s.destroy();
  await closed(s);
  assert.equal(alive(pid), false);
  assert.equal(s.reason, null);
  assert.deepEqual(await s.exited, { reason: null });
  server.close();
});

test('openStream: a child whose output ended is told that its input ended, and goes before the time is up', async () => {
  // The service ends its side first; the fake, as ssh does, goes once both sides ended.
  const server = await service((s) => s.end('bye'));
  const { env, socket } = setup(server.port);
  const s = openStream(streamArgs({ socket, jumps: [], to: 'db:1' }), env);
  assert.equal((await collect(s)).toString(), 'bye');
  const started = Date.now();
  s.destroy();
  await closed(s);
  assert.ok(Date.now() - started < 900, 'the child was not left to the kill after one second');
  assert.equal(s.reason, null);
  server.close();
});

test('openStream: a child whose output ended is given a moment to exit, then killed', async () => {
  const server = await service((sock) => sock.end());
  const { env, socket } = setup(server.port, { [LINGER_KEY]: '1' });
  const s = openStream(streamArgs({ socket, jumps: [], to: 'db:1' }), env);
  await collect(s);
  const [pid] = pids(env);
  assert.equal(alive(pid), true);
  const started = Date.now();
  s.destroy();
  await closed(s);
  assert.ok(Date.now() - started >= 900);
  assert.equal(alive(pid), false);
  assert.equal(s.reason, null);
  server.close();
});

test('openListener: closed while nobody holds it, and connect is never called then', async () => {
  let calls = 0;
  const listener = await openListener(() => {
    calls += 1;
    return new Duplex({ read() {}, write(c, e, cb) { cb(); } });
  });
  assert.equal(listener.host, '127.0.0.1');
  const c = await client(listener.port);
  c.resume();
  await closed(c);
  assert.equal(calls, 0);
  await listener.close();
});

test('openListener: 1 MiB both ways through the listener, half close, then nothing left after close', async () => {
  const server = await echo();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: ['ssh u@192.0.2.10'], to: '10.0.0.5:5432' });
  const listener = await openListener(() => openStream(args, env));
  const release = listener.hold();
  const data = randomBytes(1024 * 1024);
  const c = await client(listener.port);
  const got = collect(c);
  c.end(data);
  assert.ok((await got).equals(data));
  const others = await Promise.all([1, 2, 3].map(() => client(listener.port)));
  await until(() => server.sockets.size === 3, 'three connections');
  const closing = listener.close();
  let done = false;
  closing.then(() => {
    done = true;
  });
  // A round trip proves that time passed with the hold still taken.
  others[0].write('x');
  await new Promise((resolve) => {
    others[0].once('data', resolve);
  });
  assert.equal(done, false);
  release();
  release();
  await closing;
  for (const pid of pids(env)) assert.equal(alive(pid), false, `child ${pid}`);
  assert.equal(pids(env).length, 4);
  await Promise.all(others.map(closed));
  await assert.rejects(client(listener.port), { code: 'ECONNREFUSED' });
  assert.equal(await listener.close(), undefined);
  server.close();
});

test('openListener: the gate, the release and a hold taken after close', async () => {
  const server = await echo();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  const listener = await openListener(() => openStream(args, env));
  const one = listener.hold();
  const two = listener.hold();
  one();
  const c = await client(listener.port);
  c.write('ping');
  await new Promise((resolve) => {
    c.once('data', resolve);
  });
  two();
  // The last hold ended: the connection made while the gate was held is closed, and its child is gone.
  await closed(c);
  await until(() => server.sockets.size === 0, 'no connection after the last release');
  const late = await client(listener.port);
  late.resume();
  await closed(late);
  const closing = listener.close();
  const after = listener.hold();
  after();
  const refused = await client(listener.port).catch((err) => err);
  if (refused instanceof net.Socket) {
    refused.resume();
    await closed(refused);
  }
  await closing;
  await until(() => server.sockets.size === 0, 'no connection to the service after close');
  server.close();
});

test('openListener: connections kept by another process end with the call, and the next call has every place', async () => {
  const server = await echo();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  const listener = await openListener(() => openStream(args, env));
  const first = listener.hold();
  const kept = [];
  for (let i = 0; i < MAX_LISTENER_CONNECTIONS; i += 1) {
    const s = await client(listener.port);
    s.on('error', () => {});
    s.resume();
    kept.push(s);
  }
  await until(() => server.sockets.size === MAX_LISTENER_CONNECTIONS, 'sixteen kept connections');
  first();
  // The next call starts at once: its client is taken although the children of the kept connections may still be ending.
  const second = listener.hold();
  const c = await client(listener.port);
  c.write('ping');
  const answer = await new Promise((resolve) => {
    c.once('data', (d) => resolve(d.toString()));
  });
  assert.equal(answer, 'ping');
  await Promise.all(kept.map(closed));
  c.destroy();
  second();
  await listener.close();
  await until(() => server.sockets.size === 0, 'no connection to the service after close');
  server.close();
});

test('openListener: a connection ends with the holds that were taken when it was made, whatever holds follow', async () => {
  const server = await echo();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  const listener = await openListener(() => openStream(args, env));
  const said = async (s, text) => {
    s.write(text);
    return new Promise((resolve) => {
      s.once('data', (d) => resolve(d.toString()));
    });
  };
  const a = listener.hold();
  const early = await client(listener.port);
  early.on('error', () => {});
  assert.equal(await said(early, 'one'), 'one');
  const b = listener.hold();
  const both = await client(listener.port);
  both.on('error', () => {});
  assert.equal(await said(both, 'two'), 'two');
  a();
  // Made under a and b: it goes on while b is held.
  assert.equal(await said(both, 'three'), 'three');
  const c = listener.hold();
  b();
  // Every hold of their time ended, so both are closed, although c keeps the gate open.
  await Promise.all([closed(early), closed(both)]);
  const late = await client(listener.port);
  assert.equal(await said(late, 'four'), 'four');
  c();
  await closed(late);
  await listener.close();
  await until(() => server.sockets.size === 0, 'no connection to the service after close');
  server.close();
});

test('openListener: once close was asked no connection is taken, although a call still holds the gate', async () => {
  const server = await echo();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  const listener = await openListener(() => openStream(args, env));
  const release = listener.hold();
  const closing = listener.close();
  const late = await client(listener.port);
  late.resume();
  await closed(late);
  assert.equal(server.sockets.size, 0);
  release();
  await closing;
  server.close();
});

test('openListener: at most 16 connections at once', async () => {
  const server = await quiet();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  const listener = await openListener(() => openStream(args, env));
  const release = listener.hold();
  assert.equal(MAX_LISTENER_CONNECTIONS, 16);
  const clients = [];
  for (let i = 0; i < 16; i += 1) clients.push(await client(listener.port));
  await until(() => server.sockets.size === 16, 'sixteen connections');
  const extra = await client(listener.port);
  extra.resume();
  await closed(extra);
  assert.equal(server.sockets.size, 16);
  clients[0].destroy();
  await until(() => server.sockets.size === 15, 'one connection less');
  // The place is free only once the child of the connection that left is gone, so a new client is tried until one
  // is kept: a client that came too early is closed at once.
  let kept = null;
  await until(async () => {
    if (kept === null || kept.closed) {
      kept = await client(listener.port);
      kept.resume();
      kept.on('error', () => {});
    }
    return server.sockets.size === 16;
  }, 'sixteen again');
  clients.push(kept);
  for (const c of clients) c.destroy();
  await until(() => server.sockets.size === 0, 'no connection');
  release();
  await listener.close();
  server.close();
});

test('openListener: a client that leaves kills its child, and a failing child closes its client', async () => {
  const server = await quiet();
  const { env, socket } = setup(server.port);
  const args = streamArgs({ socket, jumps: [], to: 'db:1' });
  let failing = false;
  const listener = await openListener(() => openStream(args, failing ? { ...env, [FAIL_KEY]: '10' } : env));
  const release = listener.hold();
  const c = await client(listener.port);
  await until(() => server.sockets.size === 1, 'the connection');
  const [pid] = pids(env);
  c.resetAndDestroy();
  await until(() => !alive(pid), 'the child to be killed');
  failing = true;
  const e = await client(listener.port);
  e.resume();
  await closed(e);
  release();
  await listener.close();
  for (const p of pids(env)) assert.equal(alive(p), false);
  server.close();
});

test('openListener: when connect throws, the connection is closed; two listeners get two ports', async () => {
  const a = await openListener(() => {
    throw new Error('the shared connection is not open');
  });
  const b = await openListener(() => {
    throw new Error('no');
  });
  assert.notEqual(a.port, b.port);
  const release = a.hold();
  const c = await client(a.port);
  c.resume();
  await closed(c);
  release();
  await Promise.all([a.close(), b.close()]);
});

const hash8 = (host) => createHash('sha256').update(host).digest('hex').slice(0, 8);

test('sharedMasters: one connection per first server, its socket named by a hash of the host', async () => {
  const server = await echo();
  const { env } = setup(server.port);
  const log = path.join(env[STATE_KEY], 'ssh.log');
  const masters = sharedMasters({ ...env, [LOG_KEY]: log });
  const socket = masters.socketFor('bastion1');
  assert.equal(socket, path.join(socketDir(env), `tnl-${hash8('bastion1')}`));
  assert.equal(masters.socketFor('bastion1'), socket);
  const first = masters.open('bastion1');
  assert.equal(masters.open('bastion1'), first);
  assert.deepEqual(await first, { ok: true });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((argv) => argv.includes('-M')).length, 1);
  assert.equal(lines.find((argv) => argv.includes('-M')).at(-1), 'bastion1');
  assert.equal(await masters.check('bastion1'), true);
  assert.equal(await masters.check('never-opened'), false);

  const connect = masters.connector({ host: 'bastion1', jumps: [] }, '10.0.0.5:5432');
  const s = connect();
  const got = collect(s);
  s.end('through the shared connection');
  assert.equal((await got).toString(), 'through the shared connection');
  const streamLine = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(streamLine, streamArgs({ socket, jumps: [], to: '10.0.0.5:5432' }));

  await masters.closeAll();
  assert.equal(fs.existsSync(socket), false);
  assert.throws(() => connect(), { message: 'the shared connection is not open' });
  assert.equal(await masters.check('bastion1'), false);
  server.close();
});

test('sharedMasters: a server that fails stays failed, a dead connection stays down, and connect refuses both', async () => {
  const { env } = setup(1, { [key('FAKE_SSH_FAIL_HOST')]: 'badhost' });
  const masters = sharedMasters(env);
  assert.deepEqual(await masters.open('badhost'), { ok: false, error: 'ssh exited with code 255' });
  assert.deepEqual(await masters.open('badhost'), { ok: false, error: 'ssh exited with code 255' });
  assert.throws(() => masters.connector({ host: 'badhost', jumps: [] }, 'db:1')(), { message: 'the shared connection is not open' });
  assert.equal(await masters.check('badhost'), false);

  assert.deepEqual(await masters.open('good'), { ok: true });
  const connect = masters.connector({ host: 'good', jumps: [] }, 'db:1');
  fs.rmSync(masters.socketFor('good'));
  assert.equal(await masters.check('good'), false);
  assert.throws(() => connect(), { message: 'the shared connection is not open' });
  fs.writeFileSync(masters.socketFor('good'), '');
  assert.equal(await masters.check('good'), false);

  masters.socketFor('only-named');
  await masters.closeAll();
});

test('sharedMasters: the arguments of a route are checked when the connector is made', async () => {
  const { env } = setup(1);
  const masters = sharedMasters(env);
  assert.throws(() => masters.connector({ host: 'b', jumps: ['ssh h'] }, '[::1]:5432'), { message: 'an IPv6 service address cannot be used with jumps' });
  assert.throws(() => masters.connector({ host: 'b', jumps: [] }, '/tmp/s'), { message: 'the service address must be host:port or [IPv6]:port' });
  assert.throws(() => masters.connector({ host: 'b', jumps: ['ssh h;id'] }, 'db:1'), /is not allowed/);
  await masters.closeAll();
});

test('sharedMasters: at most 8 connections with jumps at once over one shared connection, without a limit for the others', async () => {
  const server = await quiet();
  const { env } = setup(server.port);
  const masters = sharedMasters(env);
  assert.deepEqual(await masters.open('bastion1'), { ok: true });
  assert.equal(MAX_JUMP_CONNECTIONS, 8);
  const jumped = masters.connector({ host: 'bastion1', jumps: ['ssh u@192.0.2.10'] }, '10.0.0.5:5432');
  const other = masters.connector({ host: 'bastion1', jumps: ['ssh -p 2222 v@192.0.2.20'] }, '10.0.0.6:5432');
  const plain = masters.connector({ host: 'bastion1', jumps: [] }, '10.0.0.7:5432');
  const streams = [];
  for (let i = 0; i < 4; i += 1) streams.push(jumped(), other());
  assert.throws(() => jumped(), { message: 'at most 8 connections with jumps may be open at once over one shared connection' });
  assert.throws(() => other(), /at most 8/);
  for (let i = 0; i < 3; i += 1) streams.push(plain());
  await until(() => server.sockets.size === 11, 'eleven connections');
  streams[0].destroy();
  await closed(streams[0]);
  streams.push(jumped());
  assert.throws(() => other(), /at most 8/);
  await until(() => server.sockets.size === 11, 'eleven connections again');
  for (const s of streams) s.destroy();
  await Promise.all(streams.map(closed));
  await masters.closeAll();
  server.close();
});

test('sharedMasters: a socket path that is too long is an error before anything opens', async () => {
  const dir = tempDir('ksproxy-tnl-long-');
  const env = { ...process.env, [SSH_KEY]: fakeSsh, [STATE_KEY]: path.join(dir, 'd'.repeat(80)) };
  const masters = sharedMasters(env);
  assert.throws(() => masters.socketFor('bastion1'), /^Error: socket path too long \(\d+ bytes, limit 83\): .*tnl-[0-9a-f]{8}; set KSPROXY_STATE_DIR to a shorter directory$/);
  const opened = await masters.open('bastion1');
  assert.equal(opened.ok, false);
  assert.match(opened.error, /^socket path too long/);
  await masters.closeAll();
});

test('sharedMasters: two hosts whose hashes would give the same socket are refused', () => {
  const { env } = setup(1);
  const seen = new Map();
  let pair = null;
  for (let i = 0; pair === null; i += 1) {
    const host = `h${i}`;
    const h = hash8(host);
    if (seen.has(h)) pair = [seen.get(h), host];
    else seen.set(h, host);
  }
  const masters = sharedMasters(env);
  masters.socketFor(pair[0]);
  assert.throws(
    () => masters.socketFor(pair[1]),
    { message: `the shared connections to ${pair[0]} and ${pair[1]} would use the same socket; write one of them in another form` },
  );
});
