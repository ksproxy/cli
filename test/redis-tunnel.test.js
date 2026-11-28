import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { main } from '../src/cli.js';
import redisKind from '../src/kinds/redis/index.js';
import { streamConnector } from '../src/kinds/engines/resp.js';
import { openStream, streamArgs } from '../src/kinds/engines/tunnel.js';
import { ensureDir, socketDir } from '../src/paths.js';
import { callTool } from '../src/tools.js';
import { respServer, simpleAnswer } from './fixtures/resp-server.js';
import { selfSigned } from './fixtures/self-signed.js';
import {
  alive, cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

// The redis kind through a tunnel: the stream of a fake ssh in stream mode, joined to a loopback RESP stand-in, is
// the socket of the exchange, with and without TLS. Unit tests call the kind's hooks with a tunnel they build from
// openStream; the start tests run a real start and a real doctor of a redis target that has a route.

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
const PASSWORD_VAR = 'REDIS_TUNNEL_PASSWORD';
const PASSWORD = 'pw-T7NNEL-5e1d-unmistakable';
const fakeSsh = new URL('./fixtures/fake-ssh.js', import.meta.url).pathname;

const servers = [];
const originalCAs = tls.getCACertificates('default');
after(async () => {
  tls.setDefaultCACertificates(originalCAs);
  for (const server of servers) await server.close();
  cleanupAll();
});
async function serve(answer = simpleAnswer, options = {}) {
  const s = await respServer(answer, options);
  servers.push(s);
  return s;
}

const pidsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const noChildLeft = (file) => waitFor(() => pidsOf(file).every((pid) => !alive(pid)), 10000, 'every stream ssh to end');

// The env of the fake ssh with a socket file that stands for the shared connection, and a tunnel of the shape the core
// gives a kind: { connect }, which makes one stream, and counts them.
function tunnelTo(port, { to = 'cache.internal:6379', extra = {} } = {}) {
  const dir = tempDir('ksproxy-rt-');
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

const target = (extra = {}) => ({
  kind: 'redis', name: 'cache', host: 'cache.internal', port: 6379, tls: false, db: 2, userEnv: null, passwordEnv: PASSWORD_VAR, allow: ['GET *'], ...extra,
});
const ctx = (extra = {}) => ({
  secrets: { [PASSWORD_VAR]: PASSWORD }, timeoutMs: 5000, maxBytes: 262144, signal: new AbortController().signal, input: 'get k', ...extra,
});
const ALLOWED = { allowed: true, rule: 'GET *' };
const GOT = { exitCode: 0, stdout: '"value-of-k"\n', stderr: '' };
const REACH = 'the server could not be reached\n';
const TLS_FAILED = 'the server could not be reached over TLS, or its certificate is not trusted for this host\n';

test('tunnelTo gives the target\'s own host and port, an IPv6 host in brackets; tls with a certificate check is the only checked case', () => {
  assert.equal(redisKind.tunnelTo(target()), 'cache.internal:6379');
  assert.equal(redisKind.tunnelTo(target({ host: '192.0.2.7', port: 7000 })), '192.0.2.7:7000');
  assert.equal(redisKind.tunnelTo(target({ host: '2001:db8::5' })), '[2001:db8::5]:6379');
  assert.equal(redisKind.tunnelTo(target(), { [PASSWORD_VAR]: PASSWORD }), 'cache.internal:6379');
  assert.equal(redisKind.tunnelListener, undefined);
  assert.equal(redisKind.tunnelProblem, undefined);
  assert.equal(redisKind.tunnelChecksCertificate(target({ tls: true })), true);
  assert.equal(redisKind.tunnelChecksCertificate(target({ tls: false })), false);
});

test('a call through a tunnel sends what a direct call sends: AUTH, SELECT, the command; the stream is the socket', async () => {
  const direct = await serve();
  const viaStream = await serve();
  const t = tunnelTo(viaStream.port);
  const plain = await redisKind.perform(target({ host: '127.0.0.1', port: direct.port }), ALLOWED, ctx());
  const tunnelled = await redisKind.perform(target(), ALLOWED, ctx({ opened: { tunnel: t.tunnel } }));
  assert.deepEqual(plain, GOT);
  assert.deepEqual(tunnelled, GOT);
  assert.deepEqual(viaStream.commands, [['AUTH', PASSWORD], ['SELECT', '2'], ['GET', 'k']]);
  assert.deepEqual(viaStream.commands, direct.commands);
  assert.equal(t.made.length, 1);
  assert.equal(t.made[0].destroyed, true);
  await noChildLeft(t.pids);
  // A target without a tunnel is untouched: an opened entry without one makes no stream.
  assert.deepEqual(await redisKind.perform(target({ host: '127.0.0.1', port: direct.port }), ALLOWED, ctx({ opened: { kind: 'redis' } })), GOT);
  assert.equal(t.made.length, 1);
});

test('the doctor works on the entry of the trial, only { kind, target } and the tunnel, and on one without a tunnel', async () => {
  const s = await serve();
  const t = tunnelTo(s.port);
  const base = { timeoutMs: 5000, signal: new AbortController().signal, secrets: { [PASSWORD_VAR]: PASSWORD } };
  const verdict = await redisKind.doctor(Object.freeze({ kind: 'redis', target: target({ db: 0 }), tunnel: t.tunnel }), base);
  assert.equal(verdict.ok, true);
  assert.deepEqual(s.commands, [['AUTH', PASSWORD], ['PING']]);
  assert.equal(t.made.length, 1);
  await noChildLeft(t.pids);
  const direct = await redisKind.doctor({ kind: 'redis', target: target({ host: '127.0.0.1', port: s.port, db: 0 }) }, base);
  assert.equal(direct.ok, true);
});

test('TLS runs over the stream and the certificate is checked against the real host: the right name passes, another is refused', async () => {
  const good = selfSigned('cache.internal');
  const other = selfSigned('other.example.com');
  const s = await serve(simpleAnswer, { tlsOptions: { cert: good.cert, key: good.key } });
  const wrong = await serve(simpleAnswer, { tlsOptions: { cert: other.cert, key: other.key } });
  const none = await serve(simpleAnswer, { tlsOptions: { cert: good.cert, key: good.key } });
  // The system authorities of this process are replaced by the test's one certificate, which is how a real one is
  // trusted: the kind adds no option of its own.
  tls.setDefaultCACertificates([good.cert, other.cert]);
  const t = tunnelTo(s.port);
  const ok = await redisKind.perform(target({ tls: true }), ALLOWED, ctx({ opened: { tunnel: t.tunnel } }));
  assert.deepEqual(ok, GOT);
  assert.deepEqual(s.commands, [['AUTH', PASSWORD], ['SELECT', '2'], ['GET', 'k']]);
  assert.equal(t.made[0].destroyed, true);
  await noChildLeft(t.pids);

  const w = tunnelTo(wrong.port);
  const refused = await redisKind.perform(target({ tls: true }), ALLOWED, ctx({ opened: { tunnel: w.tunnel } }));
  assert.deepEqual(refused, { exitCode: 1, stdout: '', stderr: TLS_FAILED });
  assert.deepEqual(wrong.commands, [], 'no password was sent to a server whose certificate is for another name');
  await noChildLeft(w.pids);

  // An address as the host is checked as an address: the certificate has no such name, and no server name is sent.
  const ip = tunnelTo(none.port, { to: '192.0.2.7:6379' });
  const byIp = await redisKind.perform(target({ tls: true, host: '192.0.2.7' }), ALLOWED, ctx({ opened: { tunnel: ip.tunnel } }));
  assert.deepEqual(byIp, { exitCode: 1, stdout: '', stderr: TLS_FAILED });
  assert.deepEqual(none.commands, []);
  await noChildLeft(ip.pids);

  // Without the authority the certificate is not trusted either, as without a tunnel.
  tls.setDefaultCACertificates(originalCAs);
  const unknown = tunnelTo(s.port);
  const before = s.commands.length;
  assert.deepEqual(await redisKind.perform(target({ tls: true }), ALLOWED, ctx({ opened: { tunnel: unknown.tunnel } })), { exitCode: 1, stdout: '', stderr: TLS_FAILED });
  assert.equal(s.commands.length, before);
  await noChildLeft(unknown.pids);
});

test('connect() that throws, and a tls.connect that throws, are clean failures; the stream of the second is destroyed', async () => {
  const throwing = { connect() { throw new Error('the shared connection is not open'); } };
  assert.deepEqual(await redisKind.perform(target(), ALLOWED, ctx({ opened: { tunnel: throwing } })), { exitCode: 1, stdout: '', stderr: REACH });
  assert.deepEqual(await redisKind.perform(target({ tls: true }), ALLOWED, ctx({ opened: { tunnel: throwing } })), { exitCode: 1, stdout: '', stderr: TLS_FAILED });
  const verdict = await redisKind.doctor({ kind: 'redis', target: target(), tunnel: throwing }, { timeoutMs: 5000, signal: new AbortController().signal, secrets: {} });
  assert.equal(verdict.ok, false);

  // tls.connect throws on an option it cannot take (a host that is not a string with a socket that is not usable).
  let destroyed = false;
  const stream = { destroy() { destroyed = true; } };
  const connect = streamConnector({ connect: () => stream });
  assert.throws(() => connect({ host: 'h', port: 1, servername: { bad: true } }, true));
  assert.equal(destroyed, true);
  assert.equal(connect.length, 2);
});

test('a stream that ends early or fails ends the call at once with the fixed text, plain and with TLS, and no child is left', async () => {
  const s = await serve();
  // The child ends without a byte: the stream ends, and the end event is enough.
  const ended = tunnelTo(s.port, { extra: { [DONE_KEY]: '' } });
  assert.deepEqual(await redisKind.perform(target(), ALLOWED, ctx({ opened: { tunnel: ended.tunnel } })), { exitCode: 1, stdout: '', stderr: 'the server closed the connection before it answered\n' });
  assert.equal(ended.made[0].destroyed, true);
  await noChildLeft(ended.pids);
  const endedTls = tunnelTo(s.port, { extra: { [DONE_KEY]: '' } });
  assert.deepEqual(await redisKind.perform(target({ tls: true }), ALLOWED, ctx({ opened: { tunnel: endedTls.tunnel } })), { exitCode: 1, stdout: '', stderr: TLS_FAILED });
  await noChildLeft(endedTls.pids);
  // The child fails: an error on the stream.
  const failed = tunnelTo(s.port, { extra: { [FAIL_KEY]: '0' } });
  assert.equal((await redisKind.perform(target(), ALLOWED, ctx({ opened: { tunnel: failed.tunnel } }))).exitCode, 1);
  assert.match((await failed.made[0].exited).reason, /Connection refused/);
  await noChildLeft(failed.pids);
  const failedTls = tunnelTo(s.port, { extra: { [FAIL_KEY]: 'quiet' } });
  assert.deepEqual(await redisKind.perform(target({ tls: true }), ALLOWED, ctx({ opened: { tunnel: failedTls.tunnel } })), { exitCode: 1, stdout: '', stderr: TLS_FAILED });
  await noChildLeft(failedTls.pids);
  assert.deepEqual(s.commands, []);
});

test('the time limit and the stop signal destroy the stream and leave no child, plain and with TLS', async () => {
  const quiet = await serve(() => null);
  const t = tunnelTo(quiet.port);
  assert.deepEqual(await redisKind.perform(target(), ALLOWED, ctx({ timeoutMs: 300, opened: { tunnel: t.tunnel } })), {
    exitCode: null, stdout: '', stderr: '', timedOut: true,
  });
  assert.equal(t.made[0].destroyed, true);
  await noChildLeft(t.pids);

  const good = selfSigned('cache.internal');
  const secure = await serve(() => null, { tlsOptions: { cert: good.cert, key: good.key } });
  tls.setDefaultCACertificates([good.cert]);
  const st = tunnelTo(secure.port);
  const stopper = new AbortController();
  const running = redisKind.perform(target({ tls: true }), ALLOWED, ctx({ signal: stopper.signal, opened: { tunnel: st.tunnel } }));
  await waitFor(() => secure.commands.length > 0, 10000, 'the command to reach the server through TLS');
  stopper.abort();
  assert.equal((await running).timedOut, true);
  assert.equal(st.made[0].destroyed, true);
  await noChildLeft(st.pids);
  tls.setDefaultCACertificates(originalCAs);

  const late = tunnelTo(quiet.port);
  const already = new AbortController();
  already.abort();
  assert.equal((await redisKind.perform(target(), ALLOWED, ctx({ signal: already.signal, opened: { tunnel: late.tunnel } }))).timedOut, true);
  assert.equal(late.made.length, 0, 'a stop before the connection makes no stream');
});

test('the read limit ends the call as for a socket, destroys the stream and leaves no child', async () => {
  const big = await serve(() => `$5000\r\n${'x'.repeat(5000)}\r\n`);
  const t = tunnelTo(big.port);
  const result = await redisKind.perform(target({ passwordEnv: null, db: 0 }), ALLOWED, ctx({ maxBytes: 200, secrets: {}, opened: { tunnel: t.tunnel } }));
  assert.equal(result.truncated, true);
  assert.equal(result.exitCode, 1);
  assert.equal(t.made[0].destroyed, true);
  await noChildLeft(t.pids);
});

// A world with one redis target that has a route and one that has none.
async function redisWorld(service, { entries, extraEnv = {} } = {}) {
  const w = await makeWorld({
    extraEnv: {
      [PASSWORD_VAR]: PASSWORD, [PORT_KEY]: String(service.port), [HEALTH_KEY]: '600000', NO_COLOR: '1', ...extraEnv,
    },
  });
  w.log = path.join(w.base, 'calls.log');
  w.env[LOG_KEY] = w.log;
  w.env[PID_KEY] = path.join(w.base, 'pids');
  const file = path.join(w.env[CONFIG_KEY], 'inventory.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, redis: entries }));
  return w;
}
const JUMP = 'ssh -i .ssh/app_key opsuser@192.0.2.10';
const ROUTE_PARTS = ['bastion1', 'app_key', 'opsuser', '192.0.2.10'];
const routed = (extra = {}) => ({
  name: 'cache', host: 'cache.internal', port: 6379, passwordEnv: PASSWORD_VAR, db: 2, allow: ['GET *', 'PING'], tunnel: { host: 'bastion1', jumps: [JUMP] }, ...extra,
});

test('a real start of a tunnelled redis target: the trial, then calls; nothing of the route in a file, a list or an answer', async () => {
  const s = await serve();
  const w = await redisWorld(s, { entries: [routed()] });
  const run = launch(w, { redis: ['cache'] });
  await ready(run);
  try {
    // The trial is the doctor check, through the tunnel: AUTH, SELECT (the target's db), PING.
    assert.deepEqual(s.commands, [['AUTH', PASSWORD], ['SELECT', '2'], ['PING']]);
    assert.match(run.proc.stderr.text, /rds +cache +OPENING +cache\.internal:6379, database 2, password from REDIS_TUNNEL_PASSWORD, through bastion1, then 1 jump$/m);
    assert.match(run.proc.stderr.text, /WARN/);
    const before = s.commands.length;
    const agentEnv = { ...w.env };
    delete agentEnv[PASSWORD_VAR];
    const answer = await callTool('redis_command', { target: 'cache', command: 'get k1' }, agentEnv);
    assert.deepEqual(answer, { text: 'exit code: 0\n--- stdout ---\n"value-of-k1"', isError: false });
    assert.deepEqual(s.commands.slice(before), [['AUTH', PASSWORD], ['SELECT', '2'], ['GET', 'k1']]);
    const texts = [answer.text, (await callTool('list_targets', {}, agentEnv)).text];
    for (const file of [path.join(w.sessionDir, 'session.json'), path.join(w.sessionDir, 'AGENT.md')]) {
      texts.push(fs.readFileSync(file, 'utf8'));
    }
    // The audit log is the owner's file and its start lines may name the first server; the entry of a call never does.
    const entries = fs.readFileSync(w.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'call');
    assert.equal(entries.length, 1);
    texts.push(JSON.stringify(entries));
    for (const text of texts) {
      for (const part of ROUTE_PARTS) assert.ok(!text.includes(part), `${part} must not appear`);
      assert.ok(!text.includes(PASSWORD));
    }
    const session = JSON.parse(fs.readFileSync(path.join(w.sessionDir, 'session.json'), 'utf8'));
    assert.deepEqual(Object.keys(session.targets.find((t) => t.name === 'cache')).sort(), [
      'allow', 'db', 'description', 'host', 'kind', 'name', 'passwordEnv', 'port', 'state', 'tls', 'userEnv',
    ]);
  } finally {
    await stopWith(run);
  }
  await noChildLeft(w.env[PID_KEY]);
});

test('ksproxy doctor on a tunnelled redis target passes, and fails with the layer when the route fails', async () => {
  const s = await serve();
  const w = await redisWorld(s, { entries: [routed({ tunnel: { host: 'bastion1' } })] });
  delete w.env[PROJECT_KEY];
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'shop.json'), JSON.stringify({ redis: [routed({ tunnel: { host: 'bastion1' } })] }));
  const proc = fakeProcess();
  const code = await main(['doctor', '--project', 'shop', '--redis', 'cache'], w.env, { process: proc });
  assert.equal(code, 0, proc.stdout.text);
  assert.match(proc.stdout.text, /rds +cache +OK/m);
  await noChildLeft(w.env[PID_KEY]);

  w.env[FAIL_KEY] = '0';
  const bad = fakeProcess();
  assert.equal(await main(['doctor', '--project', 'shop', '--redis', 'cache'], w.env, { process: bad }), 1);
  assert.match(bad.stdout.text, /rds +cache +FAIL +the route failed: channel 0: open failed: connect failed: Connection refused$/m);
  await noChildLeft(w.env[PID_KEY]);
});
