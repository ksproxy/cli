import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NO_CERTIFICATE_WHY, TUNNEL_STEP_MS, checkRouteSockets, closeTarget, openFirstServers, openTarget, openTunnel, routeText,
  routesOf, tunnelChecked, tunnelGoneText,
} from '../src/start.js';
import { sharedMasters } from '../src/kinds/engines/tunnel.js';
import { validateInventory } from '../src/inventory.js';
import { KINDS } from '../src/kinds/index.js';
import { ensureDir, socketDir } from '../src/paths.js';
import { holdTunnel, keepTunnel, tunnelControl } from '../src/tools.js';
import { checkKind } from './kind-contract.js';
import {
  resetSteer, startService, steer, tunnelledKind,
} from './fixtures/kind-tunnelled.js';
import { tempDir } from './temp.js';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const key = (name) => ['KSPROXY', name].join('_');
const SSH_KEY = key('SSH');
const STATE_KEY = key('STATE_DIR');
const PORT_KEY = key('FAKE_SSH_STREAM_PORT');
const FAIL_KEY = key('FAKE_SSH_STREAM_FAIL');
const PID_KEY = key('FAKE_SSH_PID_LOG');
const LOG_KEY = key('FAKE_SSH_LOG');
const HOST_FAIL_KEY = key('FAKE_SSH_FAIL_HOST');

const streamKind = tunnelledKind('tvs', 'tvs');
const listenerKind = tunnelledKind('tvl', 'tvl', { listener: true });
const bareKind = tunnelledKind('tvb', 'tvb', { close: false });
KINDS.push(streamKind, listenerKind, bareKind);
const service = await startService();
after(async () => {
  for (const kind of [streamKind, listenerKind, bareKind]) KINDS.splice(KINDS.indexOf(kind), 1);
  await service.close();
});
beforeEach(() => {
  resetSteer();
  service.silent = false;
  service.lines.length = 0;
});

const ROUTE = Object.freeze({ host: 'bastion1', jumps: Object.freeze([]) });
const JUMPED = Object.freeze({ host: 'bastion1', jumps: Object.freeze(['ssh -i .ssh/app_key opsuser@192.0.2.10']) });
const TARGET = (kind, name = 'a', extra = {}) => ({
  kind: kind.key, name, tokenEnv: 'TVS_TOKEN', description: '', allow: ['read *'], ...extra,
});
const SECRETS = { TVS_TOKEN: 'tok-unit-value' };

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
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

function setup(extra = {}) {
  const dir = tempDir('ksproxy-tnlo-');
  const env = {
    ...process.env,
    [SSH_KEY]: fakeSsh,
    [STATE_KEY]: dir,
    [PORT_KEY]: String(service.port),
    [PID_KEY]: path.join(dir, 'pids'),
    [LOG_KEY]: path.join(dir, 'ssh.log'),
    ...extra,
  };
  ensureDir(socketDir(env));
  return { dir, env, masters: sharedMasters(env) };
}

const pids = (env) => (fs.existsSync(env[PID_KEY]) ? fs.readFileSync(env[PID_KEY], 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const noChildLeft = (env) => until(() => pids(env).every((pid) => !alive(pid)), 'every stream ssh to end');

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

// A connection to a listener answers PING only while its gate is held; else it is closed at once.
function ping(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let text = '';
    s.on('data', (c) => {
      text += c;
      if (text.includes('\n')) s.destroy();
    });
    s.on('error', () => {});
    s.on('close', () => resolve(text.trim() || null));
    s.write('PING\n');
  });
}

const opening = (kind, t, route, setupOf, extra = {}) => openTunnel(kind, t, SECRETS, {
  route, masters: setupOf.masters, env: setupOf.env, signal: new AbortController().signal, ...extra,
});

test('the stand-in kinds meet the contract', () => {
  for (const kind of [streamKind, listenerKind, bareKind]) checkKind(kind, KINDS);
});

test('routeText names the first server and the number of jumps', () => {
  assert.equal(routeText(ROUTE), 'through bastion1');
  assert.equal(routeText(JUMPED), 'through bastion1, then 1 jump');
  assert.equal(routeText({ host: 'web1.example.com', jumps: ['ssh a@b', 'ssh c@d'] }), 'through web1.example.com, then 2 jumps');
  assert.equal(TUNNEL_STEP_MS, 10000);
  assert.equal(tunnelGoneText('bastion1'), 'the shared connection to bastion1 does not answer: run ksproxy start again if it stays down');
});

test('routesOf gives the route of each selected target that has one, in the order start opens them', () => {
  const entry = (name, extra = {}) => ({
    name, tokenEnv: 'TVS_TOKEN', allow: ['read *'], ...extra,
  });
  const inventory = validateInventory({
    tvl: [entry('b', { tunnel: { host: 'bastion2' } })],
    tvs: [entry('a', { tunnel: { host: 'bastion1', jumps: JUMPED.jumps } }), entry('plain')],
  });
  const routes = routesOf(inventory, { ...Object.fromEntries(KINDS.map((k) => [k.key, []])), tvs: inventory.tvs, tvl: inventory.tvl });
  assert.deepEqual([...routes.keys()], ['tvs:a', 'tvl:b']);
  assert.deepEqual(routes.get('tvs:a'), JUMPED);
  const none = routesOf(inventory, { ...Object.fromEntries(KINDS.map((k) => [k.key, []])), tvs: [inventory.tvs[1]] });
  assert.equal(none.size, 0);
});

test('checkRouteSockets checks the socket of every first server before anything opens', () => {
  const { masters } = setup();
  assert.doesNotThrow(() => checkRouteSockets(new Map([['tvs:a', ROUTE]]), masters));
  const long = setup({ [STATE_KEY]: path.join(tempDir('ksproxy-tnlo-'), 'd'.repeat(80)) });
  assert.throws(() => checkRouteSockets(new Map([['tvs:a', ROUTE]]), long.masters), /^Error: socket path too long/);
});

test('openFirstServers opens each first server once, in order, and stops when asked', async () => {
  const { env, masters } = setup();
  const routes = new Map([['tvs:a', ROUTE], ['tvl:b', JUMPED], ['tvs:c', { host: 'bastion2', jumps: [] }]]);
  await openFirstServers(routes, masters, () => false);
  const calls = fs.readFileSync(env[LOG_KEY], 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const opened = calls.filter((argv) => argv.includes('-M')).map((argv) => argv.at(-1));
  assert.deepEqual(opened, ['bastion1', 'bastion2']);
  const other = setup();
  let asked = 0;
  await openFirstServers(routes, other.masters, () => {
    asked += 1;
    return asked > 1;
  });
  const first = fs.readFileSync(other.env[LOG_KEY], 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(first.filter((argv) => argv.includes('-M')).map((argv) => argv.at(-1)), ['bastion1']);
  await masters.closeAll();
  await other.masters.closeAll();
});

test('a stream kind: the tunnel is { connect }, the trial runs through it, and close leaves no ssh', async () => {
  const s = setup();
  const t = TARGET(streamKind);
  const made = await opening(streamKind, t, ROUTE, s);
  assert.deepEqual(Object.keys(made), ['tunnel']);
  assert.deepEqual(Object.keys(made.tunnel), ['connect']);
  assert.ok(Object.isFrozen(made.tunnel));
  assert.deepEqual(service.lines, ['PING']);
  // The trial saw the entry without the extras of open, its tunnel not enumerable.
  const [trial] = steer.trials;
  assert.deepEqual(trial, { kind: 'tvs', target: t });
  assert.equal(trial.tunnel, made.tunnel);
  assert.equal(JSON.stringify(trial).includes('tunnel'), false);
  const control = tunnelControl({ tunnel: made.tunnel });
  assert.equal(control.host, 'bastion1');
  assert.equal(control.down, false);
  // A stream kind has no gate: holding gives a release that does nothing.
  holdTunnel({ tunnel: made.tunnel })();
  // A stream that is open at close is ended, its ssh with it.
  const open = made.tunnel.connect();
  await new Promise((resolve) => { open.once('connect', resolve); });
  await closeTarget(bareKind, { kind: 'tvb', target: t, tunnel: made.tunnel }, s.env, {});
  assert.equal(open.destroyed, true);
  assert.equal(control.down, true);
  await noChildLeft(s.env);
  await s.masters.closeAll();
});

test('a listener kind: the tunnel is { host, port, hold }, and the listener accepts only while held and not down', async () => {
  const s = setup();
  const made = await opening(listenerKind, TARGET(listenerKind), JUMPED, s);
  assert.deepEqual(Object.keys(made.tunnel), ['host', 'port', 'hold']);
  assert.equal(made.tunnel.host, '127.0.0.1');
  assert.deepEqual(service.lines, ['PING']);
  const entry = { tunnel: made.tunnel };
  assert.equal(await ping(made.tunnel.port), null);
  const release = holdTunnel(entry);
  assert.equal(await ping(made.tunnel.port), 'PONG');
  release();
  assert.equal(await ping(made.tunnel.port), null);
  // The kind's own hold is the same gate.
  const own = made.tunnel.hold();
  assert.equal(await ping(made.tunnel.port), 'PONG');
  own();
  // While down, the gate does not open.
  tunnelControl(entry).down = true;
  const none = holdTunnel(entry);
  assert.equal(await ping(made.tunnel.port), null);
  none();
  await tunnelControl(entry).close();
  assert.equal(await refused(made.tunnel.port), true);
  await noChildLeft(s.env);
  await s.masters.closeAll();
});

test('tunnelControl and holdTunnel of an entry without a tunnel, or of none', () => {
  assert.equal(tunnelControl(undefined), undefined);
  assert.equal(tunnelControl({ kind: 'vault' }), undefined);
  assert.equal(holdTunnel({ kind: 'vault' })(), undefined);
  // A tunnel object that the core did not keep has no state.
  assert.equal(tunnelControl({ tunnel: {} }), undefined);
  const tunnel = {};
  keepTunnel(tunnel, { hold: () => () => 'released' });
  assert.equal(holdTunnel({ tunnel })(), 'released');
});

test('a first server that failed skips the target with the text of ssh and its name', async () => {
  const s = setup({ [HOST_FAIL_KEY]: 'bastion2' });
  const made = await opening(streamKind, TARGET(streamKind), { host: 'bastion2', jumps: [] }, s);
  assert.deepEqual(made, { skipped: 'ssh exited with code 255', firstServer: 'bastion2' });
  assert.deepEqual(steer.trials, []);
  await s.masters.closeAll();
});

test('tunnelTo: a refusal, a throw, another shape and a broken address each skip the target, and nothing opens', async () => {
  const s = setup();
  const t = TARGET(streamKind);
  steer.to = () => ({ error: 'a test refusal of this address' });
  assert.deepEqual(await opening(streamKind, t, ROUTE, s), { skipped: 'a test refusal of this address' });
  steer.to = (target, secrets) => {
    throw new Error(`broke with ${secrets.TVS_TOKEN}`);
  };
  assert.deepEqual(await opening(streamKind, t, ROUTE, s), { skipped: 'the address of the service could not be found' });
  for (const shape of [5432, null, undefined, { error: 5 }, ['svc.example.com:5432']]) {
    steer.to = () => shape;
    assert.deepEqual(await opening(streamKind, t, ROUTE, s), { skipped: 'the address of the service could not be found' });
  }
  steer.to = () => '/run/svc.sock';
  assert.deepEqual(await opening(streamKind, t, ROUTE, s), { skipped: 'the service address must be host:port or [IPv6]:port' });
  steer.to = () => '[2001:db8::5]:5432';
  assert.deepEqual(await opening(streamKind, t, JUMPED, s), { skipped: 'an IPv6 service address cannot be used with jumps' });
  assert.deepEqual(steer.trials, []);
  assert.deepEqual(pids(s.env), []);
  await s.masters.closeAll();
});

test('a listener that cannot open skips the target', async () => {
  const s = setup();
  const made = await opening(listenerKind, TARGET(listenerKind), ROUTE, s, { listen: () => Promise.reject(new Error('no room')) });
  assert.deepEqual(made, { skipped: 'the loopback port could not be opened: no room' });
  await s.masters.closeAll();
});

test('a trial whose ssh ended with an error is a failure of the route, with its reason on one line', async () => {
  for (const kind of [streamKind, listenerKind]) {
    const s = setup({ [FAIL_KEY]: '0' });
    const made = await opening(kind, TARGET(kind), ROUTE, s);
    assert.deepEqual(made, { skipped: 'the route failed: channel 0: open failed: connect failed: Connection refused' });
    await noChildLeft(s.env);
    await s.masters.closeAll();
  }
  const s = setup({ [FAIL_KEY]: '400' });
  const made = await opening(streamKind, TARGET(streamKind), ROUTE, s);
  assert.equal(made.skipped.length, 'the route failed: '.length + 300);
  assert.match(made.skipped, /^the route failed: channel 0: open failed: connect failed: Connection refused; x+…$/);
  await s.masters.closeAll();
});

test('a trial whose connection could not be made is a failure of the route', async () => {
  const s = setup();
  steer.onDoctor = async () => {
    fs.rmSync(s.masters.socketFor('bastion1'));
    assert.equal(await s.masters.check('bastion1'), false);
  };
  assert.deepEqual(await opening(streamKind, TARGET(streamKind), ROUTE, s), { skipped: 'the route failed: the shared connection is not open' });
  await s.masters.closeAll();
});

test('a trial that fails through a route that works is a failure of the service', async () => {
  service.silent = true;
  for (const kind of [streamKind, listenerKind]) {
    const s = setup();
    const made = await opening(kind, TARGET(kind), ROUTE, s);
    assert.deepEqual(made, { skipped: 'the service did not answer through the tunnel: no answer to PING' });
    await noChildLeft(s.env);
    await s.masters.closeAll();
  }
});

test('a doctor hook that throws, gives another shape, or does not finish in time fails the trial', async () => {
  const s = setup();
  const t = TARGET(streamKind);
  const base = { ...streamKind };
  const cases = [
    [async () => { throw new Error('broke'); }, 'the check failed'],
    [async () => ({ ok: 'yes', detail: 'x' }), 'the check failed'],
    [async () => null, 'the check failed'],
    [async () => ({ ok: true }), 'the check failed'],
    [async () => ({ ok: false, detail: 'line one\n  line two' }), 'line one; line two'],
  ];
  for (const [doctor, detail] of cases) {
    const made = await opening({ ...base, doctor }, t, ROUTE, s);
    assert.deepEqual(made, { skipped: `the service did not answer through the tunnel: ${detail}` });
  }
  // The time limit: the step for the first server and for each jump, and one step more.
  let seen = null;
  const slow = {
    ...base,
    doctor: (opened, { timeoutMs, signal }) => {
      seen = timeoutMs;
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ ok: true, detail: 'late' })); });
    },
  };
  assert.deepEqual(await opening(slow, t, JUMPED, s, { stepMs: 10 }), { skipped: 'the service did not answer through the tunnel: the check did not finish within 0.03 seconds' });
  assert.equal(seen, 30);
  // A kind without a doctor hook has no trial.
  const none = { ...base };
  delete none.doctor;
  assert.deepEqual(Object.keys(await opening(none, t, ROUTE, s)), ['tunnel']);
  await s.masters.closeAll();
});

test('a stop during the trial closes the tunnel and gives late, for both kinds', async () => {
  for (const kind of [streamKind, listenerKind]) {
    const s = setup();
    const controller = new AbortController();
    let port = null;
    steer.onDoctor = (opened) => {
      port = opened.tunnel.port ?? null;
      controller.abort();
    };
    const made = await opening(kind, TARGET(kind), ROUTE, s, { signal: controller.signal });
    assert.deepEqual(made, { late: true });
    if (port !== null) assert.equal(await refused(port), true);
    await noChildLeft(s.env);
    await s.masters.closeAll();
  }
  // A stop that came before: the trial ends at once.
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  steer.onDoctor = null;
  assert.deepEqual(await opening(streamKind, TARGET(streamKind), ROUTE, s, { signal: controller.signal }), { late: true });
  await s.masters.closeAll();
});

test('a stop that comes while a failed trial waits for its reason gives late, and nothing is said', async () => {
  const s = setup();
  const controller = new AbortController();
  // The hook leaves a stream that is ending: its end, which the wait for the reason of the route waits for, fires the stop.
  const kind = {
    ...streamKind,
    doctor: async (opened) => {
      const stream = opened.tunnel.connect();
      stream.once('close', () => controller.abort());
      stream.destroy();
      return { ok: false, detail: 'reason-1', wayOut: 'way-out-1' };
    },
  };
  assert.deepEqual(await opening(kind, TARGET(streamKind), ROUTE, s, { signal: controller.signal }), { late: true });
  await noChildLeft(s.env);
  await s.masters.closeAll();
});

test('a way out counts only when it and the reason are texts that are not empty', async () => {
  const s = setup();
  const t = TARGET(streamKind);
  const silent = 'the service did not answer through the tunnel: ';
  const cases = [
    [{ ok: false, detail: 'reason-1', wayOut: 'way-out-1' }, { skipped: 'reason-1', wayOut: 'way-out-1' }],
    [{ ok: false, detail: 'reason-1', wayOut: '' }, { skipped: `${silent}reason-1` }],
    [{ ok: false, detail: 'reason-1', wayOut: ' \n ' }, { skipped: `${silent}reason-1` }],
    [{ ok: false, detail: 'reason-1', wayOut: 5 }, { skipped: `${silent}reason-1` }],
    [{ ok: false, detail: '', wayOut: 'way-out-1' }, { skipped: silent }],
    [{ ok: false, detail: '  ', wayOut: 'way-out-1' }, { skipped: silent }],
  ];
  for (const [answer, expected] of cases) {
    const made = await opening({ ...streamKind, doctor: async () => answer }, t, ROUTE, s);
    assert.deepEqual(made, expected, JSON.stringify(answer));
  }
  await s.masters.closeAll();
});

test('tunnelChecked: a check sets down, and once the control was closed it stays down whatever a late check says', async () => {
  const s = setup();
  const made = await opening(listenerKind, TARGET(listenerKind), ROUTE, s);
  const control = tunnelControl({ tunnel: made.tunnel });
  assert.equal(control.closed, false);
  assert.equal(tunnelChecked(control, false), true);
  assert.equal(control.down, true);
  assert.equal(tunnelChecked(control, true), false);
  assert.equal(control.down, false);
  // A check that began before the close and ends after it: it passed, but the tunnel is closed.
  const late = control.check();
  await control.close();
  assert.equal(control.closed, true);
  assert.equal(tunnelChecked(control, await late), true);
  assert.equal(control.down, true);
  assert.equal(holdTunnel({ tunnel: made.tunnel })(), undefined);
  assert.equal(await refused(made.tunnel.port), true);
  await noChildLeft(s.env);
  await s.masters.closeAll();
});

test('closeTarget: the kind closes first, then its tunnel, within the limit of each', async () => {
  const s = setup();
  const made = await opening(listenerKind, TARGET(listenerKind), ROUTE, s);
  const order = [];
  const control = tunnelControl({ tunnel: made.tunnel });
  const close = control.close;
  control.close = async () => {
    order.push('tunnel');
    await close();
  };
  const kind = {
    ...listenerKind,
    close: async () => { order.push('kind'); },
  };
  await closeTarget(kind, { kind: 'tvl', target: TARGET(listenerKind), tunnel: made.tunnel }, s.env, { tunnelCloseMs: 2000 });
  assert.deepEqual(order, ['kind', 'tunnel']);
  assert.equal(await refused(made.tunnel.port), true);
  // A tunnel close that does not end is waited for only up to its limit.
  const stuck = {};
  keepTunnel(stuck, { close: () => new Promise(() => {}) });
  const started = Date.now();
  await closeTarget(bareKind, { kind: 'tvb', target: TARGET(bareKind), tunnel: stuck }, s.env, { tunnelCloseMs: 20 });
  assert.ok(Date.now() - started < 2000);
  // Without a tunnel, only the kind.
  await closeTarget(kind, { kind: 'tvl', target: TARGET(listenerKind) }, s.env, {});
  assert.deepEqual(order, ['kind', 'tunnel', 'kind']);
  await s.masters.closeAll();
});

// openTarget with a tunnel, as start and doctor call it.
function openOf(kind, t, s, extra = {}) {
  const lines = [];
  const opened = [];
  const secretsSeen = [];
  const run = openTarget(kind, t, {
    held: new Map([['TVS_TOKEN', SECRETS.TVS_TOKEN]]),
    ports: { used: new Map(), unreadable: null },
    context: { env: s.env, signal: extra.signal ?? new AbortController().signal, say: () => {} },
    lifecycle: (entry) => lines.push(`${entry.event} ${entry.message ?? ''}`.trim()),
    open: extra.open ?? ((call) => call()),
    onOpened: (o) => opened.push(o),
    onSecrets: (secrets) => secretsSeen.push(secrets),
    tunnel: { route: extra.route ?? JUMPED, masters: s.masters },
  });
  return {
    run, lines, opened, secretsSeen,
  };
}

test('openTarget with a tunnel: OPENING names the route, one WARN without a checked certificate, the entry gets the tunnel', async () => {
  const s = setup();
  const t = TARGET(listenerKind);
  const { run, lines, opened, secretsSeen } = openOf(listenerKind, t, s);
  const result = await run;
  assert.deepEqual(lines, [
    'target_opening token from TVS_TOKEN, through bastion1, then 1 jump',
    `target_warn ${NO_CERTIFICATE_WHY}`,
    'target_up',
  ]);
  assert.deepEqual(secretsSeen, [SECRETS]);
  const [entry] = opened;
  assert.equal(result.opened, entry);
  assert.deepEqual(entry, { kind: 'tvl', target: t, opener: 'tvl' });
  assert.equal(entry.tunnel, steer.tunnels.get('a'));
  assert.equal(JSON.stringify(entry).includes(String(entry.tunnel.port)), false);
  assert.deepEqual(Object.keys(entry), ['kind', 'target', 'opener']);
  await closeTarget(listenerKind, entry, s.env, {});
  // A target that checks the certificate has no WARN.
  const checked = openOf(streamKind, TARGET(streamKind, 'c', { description: 'checked' }), s, { route: ROUTE });
  await checked.run;
  assert.deepEqual(checked.lines, ['target_opening token from TVS_TOKEN, through bastion1', 'target_up']);
  await closeTarget(streamKind, checked.opened[0], s.env, {});
  // A kind without the hook does not check one.
  const plain = { ...streamKind };
  delete plain.tunnelChecksCertificate;
  const unchecked = openOf(plain, TARGET(streamKind, 'd', { description: 'checked' }), s, { route: ROUTE });
  await unchecked.run;
  assert.equal(unchecked.lines[1], `target_warn ${NO_CERTIFICATE_WHY}`);
  await closeTarget(plain, unchecked.opened[0], s.env, {});
  await noChildLeft(s.env);
  await s.masters.closeAll();
});

test('openTarget with a tunnel: the gate is held while open runs, and released after', async () => {
  const s = setup();
  const answers = [];
  steer.onOpen = async (target, ctx) => {
    answers.push(await ping(ctx.tunnel.port));
  };
  const { run } = openOf(listenerKind, TARGET(listenerKind), s);
  const { opened } = await run;
  assert.deepEqual(answers, ['PONG']);
  assert.equal(await ping(opened.tunnel.port), null);
  await closeTarget(listenerKind, opened, s.env, {});
  await s.masters.closeAll();
});

test('openTarget with a tunnel: a skip of the tunnel, a failed open, a late open and a throwing open close everything', async () => {
  const s = setup();
  steer.to = () => ({ error: 'refused here' });
  const skipped = openOf(listenerKind, TARGET(listenerKind), s);
  assert.deepEqual(await skipped.run, { skipped: 'refused here' });
  assert.equal(skipped.lines.at(-1), 'target_skipped refused here');
  steer.to = () => 'svc.example.com:5432';

  steer.openResult = { ok: false, error: 'open said no' };
  const failed = openOf(listenerKind, TARGET(listenerKind), s);
  assert.deepEqual(await failed.run, { skipped: 'open said no' });
  assert.equal(await refused(steer.tunnels.get('a').port), true);
  assert.deepEqual(failed.opened, []);

  steer.openResult = null;
  const late = openOf(listenerKind, TARGET(listenerKind), s, { open: async (call) => ({ ...(await call()), ok: false, late: true }) });
  assert.deepEqual(await late.run, { late: true });
  assert.equal(await refused(steer.tunnels.get('a').port), true);

  steer.onOpen = async () => { throw new Error('open broke'); };
  const thrown = openOf(listenerKind, TARGET(listenerKind), s);
  await assert.rejects(thrown.run, /open broke/);
  assert.equal(await refused(steer.tunnels.get('a').port), true);

  // A stop during the trial gives late before open.
  steer.onOpen = null;
  const controller = new AbortController();
  steer.onDoctor = () => controller.abort();
  const stopped = openOf(listenerKind, TARGET(listenerKind, 'e'), s, { signal: controller.signal });
  assert.deepEqual(await stopped.run, { late: true });
  assert.equal(steer.tunnels.has('e'), false);
  await noChildLeft(s.env);
  await s.masters.closeAll();
});
