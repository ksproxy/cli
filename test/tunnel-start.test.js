import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { main } from '../src/cli.js';
import { KINDS } from '../src/kinds/index.js';
import { tunnelGoneText, NO_CERTIFICATE_WHY } from '../src/start.js';
import { callTool } from '../src/tools.js';
import {
  resetSteer, startService, steer, tunnelledKind,
} from './fixtures/kind-tunnelled.js';
import {
  alive, cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

// A real start, and a real doctor, of targets with a route, through the fake ssh in stream mode, with stand-in
// kinds: tvs takes the stream (tunnel.connect), tvl connects to a loopback listener (tunnel.host and tunnel.port),
// tvb takes the stream and has no close. No real kind has the hooks yet.

const key = (name) => ['KSPROXY', name].join('_');
const PORT_KEY = key('FAKE_SSH_STREAM_PORT');
const FAIL_KEY = key('FAKE_SSH_STREAM_FAIL');
const PID_KEY = key('FAKE_SSH_PID_LOG');
const LOG_KEY = key('FAKE_SSH_LOG');
const HOST_FAIL_KEY = key('FAKE_SSH_FAIL_HOST');
const CHECK_MS_KEY = key('FAKE_SSH_CHECK_MS');
const CHECK_FAIL_KEY = key('FAKE_SSH_CHECK_FAIL_ONCE');
const HEALTH_KEY = key('HEALTH_MS');
const STATE_KEY = key('STATE_DIR');
const CONFIG_KEY = key('CONFIG_DIR');
const PROJECT_KEY = key('PROJECT');
const TOKEN = 'tok-start-S3CR3T-value';

const streamKind = tunnelledKind('tvs', 'tvs');
const listenerKind = tunnelledKind('tvl', 'tvl', { listener: true });
const bareKind = tunnelledKind('tvb', 'tvb', { close: false });
KINDS.push(streamKind, listenerKind, bareKind);
const service = await startService();
after(async () => {
  for (const kind of [streamKind, listenerKind, bareKind]) KINDS.splice(KINDS.indexOf(kind), 1);
  cleanupAll();
  await service.close();
});
beforeEach(() => {
  resetSteer();
  service.silent = false;
  service.lines.length = 0;
});

const JUMP = 'ssh -i .ssh/app_key opsuser@192.0.2.10';
// The parts of a route, and the service address, that must never reach the agent.
const ROUTE_PARTS = ['bastion1', 'bastion2', 'app_key', 'opsuser', '192.0.2.10', 'svc.example.com'];
const entry = (name, tunnel, extra = {}) => ({
  name, tokenEnv: 'TVS_TOKEN', allow: ['read *', 'hold'], tunnel, ...extra,
});
const A = entry('a', { host: 'bastion1' });
const B = entry('b', { host: 'bastion1', jumps: [JUMP] }, { description: 'checked' });
const C = entry('c', { host: 'bastion2' });

// A world whose inventory holds the ssh target web1 and the given stand-in targets. The fake ssh joins every stream
// to the service and logs its arguments to the same file the stand-ins log their hooks to.
async function tunnelWorld({
  tvs = [], tvl = [], tvb = [], ssh, extraEnv = {},
} = {}) {
  const w = await makeWorld({
    ...(ssh === undefined ? {} : { ssh }),
    extraEnv: {
      TVS_TOKEN: TOKEN, [PORT_KEY]: String(service.port), [HEALTH_KEY]: '600000', NO_COLOR: '1', ...extraEnv,
    },
  });
  w.log = path.join(w.base, 'calls.log');
  w.env[LOG_KEY] = w.log;
  w.env[PID_KEY] = path.join(w.base, 'pids');
  steer.log = w.log;
  const file = path.join(w.env[CONFIG_KEY], 'inventory.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({
    ...raw, tvs, tvl, tvb,
  }));
  return w;
}

// The log as short texts: master, check and exit HOST for the shared connections, stream ADDRESS for a stream ssh
// (the last address of a nested command), exec for an ssh call, and KIND EVENT NAME for a hook of a stand-in.
function events(w) {
  if (!fs.existsSync(w.log)) return [];
  return fs.readFileSync(w.log, 'utf8').trim().split('\n').map((line) => {
    const item = JSON.parse(line);
    if (!Array.isArray(item)) return `${item.kind} ${item.event} ${item.name}`;
    if (item[0] === '-F' && item[1] === '/dev/null') {
      const w0 = item.indexOf('-W');
      return w0 === -1 ? `stream ${item.at(-1).split(' ').at(-2)}` : `stream ${item[w0 + 1]}`;
    }
    if (item.includes('-M')) return `master ${item.at(-1)}`;
    const op = item[item.indexOf('-O') + 1];
    return item.includes('-O') ? `${op} ${item.at(-1)}` : 'exec';
  });
}
const tunnelEvents = (w) => events(w).filter((e) => !e.endsWith('web1.example.com') && e !== 'exec');
const streamArgs = (w) => fs.readFileSync(w.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((item) => Array.isArray(item) && item[0] === '-F' && item[1] === '/dev/null');

const auditEntries = (w) => fs.readFileSync(w.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const said = (w, event) => auditEntries(w).filter((e) => e.event === event).map((e) => `${e.target} ${e.message ?? ''}`.trim());
const pids = (w) => (fs.existsSync(w.env[PID_KEY]) ? fs.readFileSync(w.env[PID_KEY], 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const noChildLeft = (w) => waitFor(() => pids(w).every((pid) => !alive(pid)), 10000, 'every stream ssh to end');
const tnlSockets = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('tnl-')) : []);

function refused(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('error', () => resolve(true));
    s.on('connect', () => {
      s.destroy();
      resolve(false);
    });
  });
}

const OPENED = [
  'master bastion1', 'check bastion1', 'master bastion2', 'check bastion2',
  'tvs tunnelTo a', 'tvs doctor a', 'stream svc.example.com:5432', 'tvs open a',
  'tvs tunnelTo c', 'tvs doctor c', 'stream svc.example.com:5432', 'tvs open c',
  'tvl tunnelTo b', 'tvl doctor b', 'stream svc.example.com:5432', 'tvl open b',
];

test('start opens the first servers one at a time, then each target: tunnelTo, the trial, open; Ctrl-C closes in reverse', async () => {
  const w = await tunnelWorld({ tvs: [A, C], tvl: [B] });
  const run = launch(w, { all: true });
  await ready(run);
  // closeMaster runs before each openMaster, as for an ssh target.
  assert.deepEqual(tunnelEvents(w).filter((e) => !e.startsWith('exit')), OPENED);
  assert.deepEqual(tunnelEvents(w).slice(0, 4), ['exit bastion1', 'master bastion1', 'check bastion1', 'exit bastion2']);
  // The ssh target opened first, and the first servers only once before the first target with a route.
  const all = events(w);
  assert.ok(all.indexOf('master web1.example.com') < all.indexOf('master bastion1'));
  assert.equal(all.filter((e) => e === 'master bastion1').length, 1);
  assert.deepEqual(service.lines, ['PING', 'PING', 'PING']);
  const lines = run.proc.stderr.text;
  assert.match(lines, /tvs +a +OPENING +token from TVS_TOKEN, through bastion1$/m);
  assert.match(lines, /tvl +b +OPENING +token from TVS_TOKEN, through bastion1, then 1 jump$/m);
  // One WARN for each target that does not check a certificate: a and c, not b.
  assert.deepEqual(said(w, 'target_warn').filter((l) => l.includes(NO_CERTIFICATE_WHY)), [`a ${NO_CERTIFICATE_WHY}`, `c ${NO_CERTIFICATE_WHY}`]);
  assert.equal(tnlSockets(w.socketDir).length, 2);

  // A call that keeps a connection open through the listener when Ctrl-C comes.
  const holding = callTool('tvl_read', { target: 'b', command: 'hold' }, w.env);
  await waitFor(() => service.lines.includes('GET hold'), 10000, 'the held call');
  const port = steer.tunnels.get('b').port;
  const before = events(w).length;
  await stopWith(run);
  assert.match((await holding).text, /REFUSED|held/);
  const closing = events(w).slice(before).filter((e) => !e.endsWith('web1.example.com'));
  // The kinds close first, in the order they opened, then the shared connections, one at a time.
  assert.deepEqual(closing, ['tvs close a', 'tvs close c', 'tvl close b', 'exit bastion1', 'exit bastion2']);
  assert.equal(await refused(port), true);
  await noChildLeft(w);
  assert.ok(pids(w).length >= 4);
  assert.deepEqual(tnlSockets(w.socketDir), []);
});

test('a first server that fails skips every target behind it with the text of ssh; the others open', async () => {
  const w = await tunnelWorld({ tvs: [A, C], tvl: [B], extraEnv: { [HOST_FAIL_KEY]: 'bastion2' } });
  const run = launch(w, { all: true });
  await ready(run);
  try {
    assert.deepEqual(said(w, 'target_skipped'), ['c ssh exited with code 255']);
    assert.deepEqual(tunnelEvents(w).filter((e) => e.includes(' open ')), ['tvs open a', 'tvl open b']);
    assert.equal(tunnelEvents(w).includes('tvs tunnelTo c'), false);
    const session = JSON.parse(fs.readFileSync(path.join(w.sessionDir, 'session.json'), 'utf8'));
    assert.deepEqual(session.targets.map((t) => t.name), ['web1', 'a', 'b']);
  } finally {
    await stopWith(run);
  }
  await noChildLeft(w);
});

test('a trial that fails skips the target and its open never runs: the route, then the service', async () => {
  const route = await tunnelWorld({ tvs: [A], tvl: [B], extraEnv: { [FAIL_KEY]: '0' } });
  const run = launch(route, { all: true });
  await ready(run);
  await stopWith(run);
  const why = 'the route failed: channel 0: open failed: connect failed: Connection refused';
  assert.deepEqual(said(route, 'target_skipped'), [`a ${why}`, `b ${why}`]);
  assert.equal(tunnelEvents(route).some((e) => e.includes(' open ')), false);
  await noChildLeft(route);

  service.silent = true;
  const quiet = await tunnelWorld({ tvs: [A], tvl: [B] });
  const second = launch(quiet, { all: true });
  await ready(second);
  await stopWith(second);
  const silent = 'the service did not answer through the tunnel: no answer to PING';
  assert.deepEqual(said(quiet, 'target_skipped'), [`a ${silent}`, `b ${silent}`]);
  assert.equal(tunnelEvents(quiet).some((e) => e.includes(' open ')), false);
  await noChildLeft(quiet);
});

test('a tunnelled target whose TLS check fails is SKIPPED with the reason and the way out of an untunnelled one', async () => {
  const { doctor } = streamKind;
  // The trial reaches the service, then gives a reason and a way out, as a kind's TLS check does.
  streamKind.doctor = async (opened, ctx) => {
    await doctor(opened, ctx);
    return { ok: false, detail: 'reason-1', wayOut: 'way-out-1' };
  };
  try {
    const w = await tunnelWorld({ tvs: [A] });
    const run = launch(w, { all: true });
    await ready(run);
    await stopWith(run);
    const lines = run.proc.stderr.text.split('\n');
    const skippedAt = lines.findIndex((line) => / tvs +a +SKIPPED /.test(line));
    assert.match(lines[skippedAt], /^\S+ +tvs +a +SKIPPED +reason-1$/);
    // The way out is a line of its own right before SKIPPED, with the columns of a line the kind says, never in the
    // audit log.
    assert.match(lines[skippedAt - 1], /^\S+ +tvs +a +way-out-1$/);
    assert.equal(lines.filter((line) => line.includes('way-out-1')).length, 1);
    assert.deepEqual(said(w, 'target_skipped'), ['a reason-1']);
    assert.equal(fs.readFileSync(w.auditLog, 'utf8').includes('way-out-1'), false);
    assert.equal(tunnelEvents(w).some((e) => e.includes(' open ')), false);
    await noChildLeft(w);

    // A route failure in the same trial still wins, and no way out is said.
    const route = await tunnelWorld({ tvs: [A], extraEnv: { [FAIL_KEY]: '0' } });
    const second = launch(route, { all: true });
    await ready(second);
    await stopWith(second);
    assert.deepEqual(said(route, 'target_skipped'), ['a the route failed: channel 0: open failed: connect failed: Connection refused']);
    assert.equal(second.proc.stderr.text.includes('way-out-1'), false);
    await noChildLeft(route);
  } finally {
    streamKind.doctor = doctor;
  }
});

test('a stop during the first-server phase closes what opened and opens no target', async () => {
  const w = await tunnelWorld({ tvs: [A, C], ssh: [], extraEnv: { [CHECK_MS_KEY]: '400' } });
  const run = launch(w, { all: true });
  await waitFor(() => events(w).includes('master bastion1'), 10000, 'the first server to open');
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  assert.deepEqual(tunnelEvents(w), ['exit bastion1', 'master bastion1', 'check bastion1', 'exit bastion1']);
  assert.deepEqual(tnlSockets(w.socketDir), []);
  assert.deepEqual(pids(w), []);
});

test('a stop during the trial closes the listener and the stream, and open never runs', async () => {
  const w = await tunnelWorld({ tvl: [B, { ...B, name: 'b2' }] });
  let port = null;
  let run = null;
  steer.onDoctor = (opened) => {
    port = opened.tunnel.port;
    run.proc.emit('SIGINT');
  };
  run = launch(w, { all: true });
  assert.equal(await run.done, 0);
  assert.deepEqual(tunnelEvents(w).filter((e) => e.startsWith('tvl')), ['tvl tunnelTo b', 'tvl doctor b']);
  assert.equal(await refused(port), true);
  await noChildLeft(w);
  assert.deepEqual(tnlSockets(w.socketDir), []);
  assert.equal(tunnelEvents(w).at(-1), 'exit bastion1');
});

test('a stop during open: a kind with close is closed again, a kind without one is closed by the core', async () => {
  for (const [kind, list] of [['tvl', { tvl: [B] }], ['tvb', { tvb: [A] }]]) {
    const w = await tunnelWorld(list);
    let run = null;
    steer.onOpen = () => run.proc.emit('SIGINT');
    run = launch(w, { all: true });
    assert.equal(await run.done, 0);
    const name = kind === 'tvl' ? 'b' : 'a';
    if (kind === 'tvl') {
      assert.ok(tunnelEvents(w).includes('tvl close b'));
      assert.equal(await refused(steer.tunnels.get(name).port), true);
    }
    assert.equal(steer.tunnels.get(name).connect === undefined, kind === 'tvl');
    await noChildLeft(w);
    assert.deepEqual(tnlSockets(w.socketDir), []);
    assert.equal(tunnelEvents(w).at(-1), 'exit bastion1');
  }
});

test('a dead shared connection makes its targets DOWN, a call on one fails cleanly, and they stay DOWN', async () => {
  const w = await tunnelWorld({ tvs: [A], tvl: [B], extraEnv: { [HEALTH_KEY]: '200' } });
  const run = launch(w, { all: true });
  await ready(run);
  try {
    // The probes run through the tunnels while the connection lives.
    await waitFor(() => service.lines.filter((l) => l === 'PING').length >= 4, 10000, 'a probe through each tunnel');
    const ok = await callTool('tvs_read', { target: 'a', command: 'read k1' }, w.env);
    assert.equal(ok.isError, false);
    assert.match(ok.text, /VALUE read k1/);
    const [socket] = tnlSockets(w.socketDir);
    fs.rmSync(path.join(w.socketDir, socket));
    await waitFor(() => said(w, 'target_down').length === 2, 10000, 'the DOWN lines');
    // The health loop checks the targets one after another: it checks the shared connection, then asks the kind. When
    // the socket goes, at most one target is between its check and its probe, so at most one DOWN line carries the
    // kind's own text; the other carries the text of the lost connection.
    const gone = tunnelGoneText('bastion1');
    const downs = said(w, 'target_down');
    assert.equal(downs.length, 2);
    // The target in flight gets its line first, so the lines come in either order: each is found by its name.
    const [ofA, ofB] = ['a ', 'b '].map((name) => downs.find((line) => line.startsWith(name)));
    assert.ok(ofA === `a ${gone}` || ofA === 'a tvs is not answering', String(ofA));
    assert.ok(ofB === `b ${gone}` || ofB === 'b tvl is not answering', String(ofB));
    assert.ok(downs.includes(`a ${gone}`) || downs.includes(`b ${gone}`), 'at least one line names the lost connection');
    const refusal = 'the connection to this target is down';
    for (const [tool, name] of [['tvs_read', 'a'], ['tvl_read', 'b']]) {
      const refused = { text: `REFUSED (${tool.slice(0, 3)} ${name}): ${refusal}`, isError: true };
      let answer;
      const before = [];
      await waitFor(async () => {
        answer = await callTool(tool, { target: name, command: 'read k1' }, w.env);
        if (answer.isError && answer.text === refused.text) return true;
        before.push(answer);
        return false;
      }, 10000, `the refusal of a call on ${name}`);
      assert.deepEqual(answer, refused);
      assert.ok(before.every((seen) => seen.isError === true), `an answer before the refusal was not an error: ${JSON.stringify(before)}`);
    }
    const audited = auditEntries(w).filter((e) => e.event === 'call' && e.decision === 'refused');
    assert.deepEqual(audited.map((e) => [e.target, e.short, e.reason]), [['a', 'target down', refusal], ['b', 'target down', refusal]]);
    // Nothing opens the connection again: three more health rounds fail their check of bastion1, the targets stay
    // DOWN with no new line, and the first server was opened once.
    const checks = () => events(w).filter((e) => e === 'check bastion1').length;
    const now = checks();
    await waitFor(() => checks() >= now + 6, 10000, 'three more health rounds');
    assert.deepEqual(said(w, 'target_recovered'), []);
    assert.equal(said(w, 'target_down').length, 2);
    assert.equal(events(w).filter((e) => e === 'master bastion1').length, 1);
    assert.deepEqual(tnlSockets(w.socketDir), []);
  } finally {
    await stopWith(run);
  }
  await noChildLeft(w);
});

test('a shared connection whose check fails once comes back: DOWN, then UP, and a call works again', async () => {
  const w = await tunnelWorld({ tvl: [B], extraEnv: { [HEALTH_KEY]: '200' } });
  const failOnce = path.join(w.base, 'fail-once');
  w.env[CHECK_FAIL_KEY] = failOnce;
  const run = launch(w, { all: true });
  await ready(run);
  try {
    await waitFor(() => service.lines.filter((l) => l === 'PING').length >= 2, 10000, 'a probe through the tunnel');
    // One check of bastion1 fails, with the master and its socket left as they are.
    fs.writeFileSync(failOnce, 'bastion1');
    await waitFor(() => said(w, 'target_recovered').length === 1, 10000, 'the UP line');
    assert.equal(fs.existsSync(failOnce), false, 'the fake failed one check');
    assert.deepEqual(said(w, 'target_down'), [`b ${tunnelGoneText('bastion1')}`]);
    assert.deepEqual(said(w, 'target_recovered'), [`b ${listenerKind.backMessage}`]);
    const lines = run.proc.stderr.text;
    assert.ok(lines.indexOf('DOWN') < lines.lastIndexOf('UP'), 'the DOWN line comes before the UP line');
    assert.match(lines, /tvl +b +UP +/);
    // The gate of the listener opens again: a call goes through the loopback port.
    const answer = await callTool('tvl_read', { target: 'b', command: 'read k1' }, w.env);
    assert.equal(answer.isError, false);
    assert.match(answer.text, /VALUE read k1/);
    assert.equal(events(w).filter((e) => e === 'master bastion1').length, 1);
  } finally {
    await stopWith(run);
  }
  await noChildLeft(w);
});

test('nothing of the route or the port reaches the agent: session files, list_targets, answers, refusals, call entries', async () => {
  const w = await tunnelWorld({ tvs: [A], tvl: [B] });
  const run = launch(w, { all: true });
  await ready(run);
  try {
    const { port } = steer.tunnels.get('b');
    const answers = [
      await callTool('list_targets', {}, w.env),
      await callTool('tvl_read', { target: 'b', command: 'read k1' }, w.env),
      await callTool('tvs_read', { target: 'a', command: 'read 10.9.9.9:22' }, w.env),
      await callTool('tvs_read', { target: 'a', command: 'write k1' }, w.env),
      await callTool('tvs_read', { target: 'a', command: 'read -oProxyCommand=x' }, w.env),
    ];
    assert.match(answers[1].text, /VALUE read k1/);
    assert.match(answers[3].text, /^REFUSED/);
    const files = fs.readdirSync(w.sessionDir, { withFileTypes: true }).filter((item) => item.isFile())
      .map((item) => fs.readFileSync(path.join(w.sessionDir, item.name), 'utf8'));
    assert.ok(files.length >= 3);
    const calls = auditEntries(w).filter((e) => e.event === 'call' || e.event === 'list').map((e) => JSON.stringify(e));
    assert.equal(calls.length, 5);
    const portRe = new RegExp(`(^|\\D)${port}(\\D|$)`);
    for (const text of [...files, ...answers.map((a) => a.text), ...calls]) {
      for (const part of [...ROUTE_PARTS, 'tunnel']) assert.ok(!text.includes(part), `${part} in ${text}`);
      assert.ok(!portRe.test(text), `the port in ${text}`);
    }
    // The agent's input never reaches the ssh command line of a tunnel: every stream goes to the target's address.
    for (const argv of streamArgs(w)) {
      const text = argv.join(' ');
      assert.ok(!text.includes('10.9.9.9') && !text.includes('ProxyCommand=x') && !text.includes('k1'), text);
      assert.match(text, /svc\.example\.com:5432/);
    }
  } finally {
    await stopWith(run);
  }
});

test('a socket path of a first server that is too long stops start before anything opens', async () => {
  const w = await tunnelWorld({ tvs: [A], ssh: [] });
  w.env[STATE_KEY] = path.join(w.base, 'x'.repeat(75 - w.base.length - 1));
  const run = launch(w, { all: true });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /socket path too long \(90 bytes, limit 83\)/);
  assert.deepEqual(events(w), []);
});

// doctor of one project, from the command line.
async function doctorOf(w, args) {
  const proc = fakeProcess();
  const code = await main(['doctor', ...args], w.env, { process: proc });
  return { code, out: proc.stdout.text };
}

function writeProject(w, project, inventory) {
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${project}.json`), JSON.stringify(inventory));
}

test('doctor of one project while a session of another project uses the same first server', async () => {
  const w = await tunnelWorld({ tvs: [A], ssh: [] });
  delete w.env[PROJECT_KEY];
  writeProject(w, 'shop', { tvl: [B] });
  const run = launch(w, { all: true });
  await ready(run);
  try {
    const [sessionSocket] = tnlSockets(w.socketDir);
    const before = events(w).length;
    const r = await doctorOf(w, ['--project', 'shop']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /tvl +b +OK +PONG$/m);
    assert.match(r.out, /1 of 1 targets OK/);
    // The doctor's trial and its check, each through its own shared connection, closed at the end of its run.
    assert.deepEqual(events(w).slice(before), [
      'exit bastion1', 'master bastion1', 'check bastion1', 'tvl tunnelTo b', 'tvl doctor b', 'stream svc.example.com:5432',
      'tvl open b', 'tvl doctor b', 'stream svc.example.com:5432', 'tvl close b', 'exit bastion1',
    ]);
    const exits = fs.readFileSync(w.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((item) => Array.isArray(item) && item.includes('exit')).map((item) => item[item.indexOf('-S') + 1]);
    assert.ok(!exits.slice(1).includes(path.join(w.socketDir, sessionSocket)));
    assert.deepEqual(fs.readdirSync(w.env[STATE_KEY]).filter((name) => name.startsWith('d-')), []);
    // The session's own connection still works.
    assert.deepEqual(tnlSockets(w.socketDir), [sessionSocket]);
    const answer = await callTool('tvs_read', { target: 'a', command: 'read k2' }, w.env);
    assert.match(answer.text, /VALUE read k2/);
  } finally {
    await stopWith(run);
  }
});

test('doctor names the layer that failed: the first server, the route, the service', async () => {
  const w = await tunnelWorld({ extraEnv: { [HOST_FAIL_KEY]: 'bastion2' } });
  delete w.env[PROJECT_KEY];
  writeProject(w, 'shop', { tvs: [A, C] });
  service.silent = true;
  const first = await doctorOf(w, ['--project', 'shop']);
  assert.equal(first.code, 1);
  assert.match(first.out, /tvs +a +FAIL +the service did not answer through the tunnel: no answer to PING$/m);
  assert.match(first.out, /tvs +c +FAIL +the first server bastion2 failed: ssh exited with code 255$/m);
  assert.match(first.out, new RegExp(`tvs +a +WARN +${NO_CERTIFICATE_WHY}$`, 'm'));
  service.silent = false;
  w.env[FAIL_KEY] = '0';
  const route = await doctorOf(w, ['--project', 'shop', '--tvs', 'a']);
  assert.match(route.out, /tvs +a +FAIL +the route failed: channel 0: open failed: connect failed: Connection refused$/m);
  await noChildLeft(w);
  assert.deepEqual(fs.readdirSync(w.env[STATE_KEY]).filter((name) => name.startsWith('d-')), []);
});

test('doctor: a stop during the first-server phase, and a socket path that is too long', async () => {
  const w = await tunnelWorld({ extraEnv: { [CHECK_MS_KEY]: '400' } });
  delete w.env[PROJECT_KEY];
  writeProject(w, 'shop', { tvs: [A, C] });
  const proc = fakeProcess();
  const running = main(['doctor', '--project', 'shop'], w.env, { process: proc });
  await waitFor(() => events(w).includes('master bastion1'), 10000, 'the first server to open');
  proc.emit('SIGINT');
  assert.equal(await running, 1);
  assert.match(proc.stdout.text, /FAIL +stopped: Ctrl-C$/m);
  assert.equal(events(w).includes('master bastion2'), false);
  assert.equal(events(w).at(-1), 'exit bastion1');

  const long = await tunnelWorld();
  delete long.env[PROJECT_KEY];
  writeProject(long, 'shop', { tvs: [A] });
  // The doctor folder is the root and /d- with six characters: 79 bytes, so its tunnel socket has 94.
  long.env[STATE_KEY] = path.join(long.base, 'y'.repeat(70 - long.base.length - 1));
  const r = await doctorOf(long, ['--project', 'shop']);
  assert.equal(r.code, 1);
  assert.match(r.out, /sockets +FAIL +socket path too long \(94 bytes, limit 83\)/);
  assert.deepEqual(events(long), []);
});

test('doctor checks the socket path that start will use for a first server', async () => {
  const name = 'orders-reporting-eu1';
  const w = await tunnelWorld({ tvs: [A] });
  delete w.env[PROJECT_KEY];
  writeProject(w, name, { tvs: [A] });
  // A root of 50 bytes: the doctor folder gives a socket of 74 bytes, the state folder of start one of 88.
  w.env[STATE_KEY] = path.join(w.base, 'r'.repeat(50 - w.base.length - 1));
  const r = await doctorOf(w, ['--project', name]);
  assert.equal(r.code, 1);
  const lines = r.out.split('\n').filter((line) => /sockets +FAIL/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /socket path too long \(88 bytes, limit 83\)/);
  assert.ok(lines[0].includes(`/p/${name}/`));
  // Doctor goes on: the route itself is checked in its own folder.
  assert.match(r.out, /tvs +a +OK +PONG/);
});

test('doctor says each socket path message once for an ssh target and a tunnelled target', async () => {
  const name = 'orders-reporting-eu1';
  const w = await tunnelWorld({ tvs: [A], ssh: [] });
  delete w.env[PROJECT_KEY];
  writeProject(w, name, { ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['read *'] }], tvs: [A] });
  w.env[STATE_KEY] = path.join(w.base, 'r'.repeat(50 - w.base.length - 1));
  const r = await doctorOf(w, ['--project', name]);
  assert.equal(r.code, 1);
  const lines = r.out.split('\n').filter((line) => /sockets +FAIL/.test(line));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /socket path too long \(84 bytes, limit 83\).*ssh-web1/);
  assert.match(lines[1], /socket path too long \(88 bytes, limit 83\)/);
  assert.equal(new Set(lines).size, 2);
});
