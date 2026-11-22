import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { sampleInventory } from '../src/inventory.js';
import { kindByKey } from '../src/kinds/index.js';
import { portListening } from '../src/kinds/kubernetes/cluster.js';
import { withProject } from '../src/paths.js';
import {
  liveSessions, otherInventories, portProblem, usedPorts,
} from '../src/projects.js';
import { writeSession } from '../src/session.js';
import { callTool } from '../src/tools.js';
import {
  alive, cleanupAll, fakeProcess, freePorts, killRecordedProxies, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

// No health check runs during these tests. A proxy ignores SIGTERM and is killed at once at the close limit: it is
// always running when it is killed.
const KUBE_QUIET = { KSPROXY_HEALTH_MS: '60000', KSPROXY_FAKE_KUBECTL_IGNORE_TERM: '1' };
const KUBE_LIMITS = { kubeCloseMs: 1 };
const kube = kindByKey('kubernetes');

const worlds = [];
after(() => {
  for (const w of worlds) {
    for (const project of ['shop', 'ops', 'web']) killRecordedProxies(path.join(w.root, 'p', project, 's'));
  }
  cleanupAll();
});

async function world() {
  const w = await makeWorld({ extraEnv: KUBE_QUIET });
  w.root = w.env.KSPROXY_STATE_DIR;
  w.cfg = w.env.KSPROXY_CONFIG_DIR;
  worlds.push(w);
  return w;
}

const envOf = (w, project) => withProject(w.env, project);
const stateOf = (w, project) => (project === null ? w.root : path.join(w.root, 'p', project));
const fileOf = (w, project) => (project === null ? path.join(w.cfg, 'inventory.json') : path.join(w.cfg, 'projects', `${project}.json`));

function writeRaw(w, project, text) {
  fs.mkdirSync(path.dirname(fileOf(w, project)), { recursive: true });
  fs.writeFileSync(fileOf(w, project), text);
}

const writeInventory = (w, project, inventory) => writeRaw(w, project, JSON.stringify(inventory));

const cluster = (w, name, proxyPort, extra = {}) => ({
  name, kubeconfig: w.kubeconfig, proxyPort, allow: ['get ...'], ...extra,
});
const web1 = (who) => ({ name: 'web1', host: `web1.${who}.example`, allow: ['uptime'] });
const skippedLines = (run) => run.proc.stderr.text.split('\n').filter((line) => /SKIPPED/.test(line))
  .map((line) => line.replace(/^\S+ /, '').replace(/ +/g, ' '));
const states = (w, project) => JSON.parse(fs.readFileSync(path.join(stateOf(w, project), 'session', 'session.json'), 'utf8'))
  .targets.map((t) => `${t.kind}:${t.name}:${t.state}`);
const hasProxy = (w, project, name = 'lab') => fs.existsSync(path.join(stateOf(w, project), 's', `kube-${name}.pid`));

async function startedOf(w, project) {
  const run = launch({ env: envOf(w, project) }, { all: true }, { limits: KUBE_LIMITS });
  await ready(run);
  return run;
}

test('two projects whose files name the same proxyPort, started at the same moment: neither opens the cluster', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  for (const who of ['shop', 'ops']) writeInventory(w, who, { ssh: [web1(who)], kubernetes: [cluster(w, 'lab', port)] });
  const shop = launch({ env: envOf(w, 'shop') }, { all: true }, { limits: KUBE_LIMITS });
  const ops = launch({ env: envOf(w, 'ops') }, { all: true }, { limits: KUBE_LIMITS });
  await ready(shop);
  await ready(ops);
  assert.deepEqual(skippedLines(shop), [`kube lab SKIPPED port ${port} is also used by project ops; give each project its own port`]);
  assert.deepEqual(skippedLines(ops), [`kube lab SKIPPED port ${port} is also used by project shop; give each project its own port`]);
  for (const who of ['shop', 'ops']) {
    assert.deepEqual(states(w, who), ['ssh:web1:up']);
    assert.equal(hasProxy(w, who), false, `${who} never started a proxy`);
  }
  assert.equal(await portListening(port), false);
  assert.equal(await stopWith(shop), 0);
  assert.equal(await stopWith(ops), 0);
});

test('after the proxy of a running project died, another project with that port is refused, by the file and by the live session', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  writeInventory(w, 'shop', { ssh: [web1('shop')], kubernetes: [cluster(w, 'lab', port)] });
  const shop = await startedOf(w, 'shop');
  assert.deepEqual(states(w, 'shop'), ['ssh:web1:up', 'kubernetes:lab:up']);
  const proxy = JSON.parse(fs.readFileSync(path.join(stateOf(w, 'shop'), 's', 'kube-lab.pid'), 'utf8')).pid;
  assert.ok(alive(proxy));
  process.kill(proxy, 'SIGKILL');
  await waitFor(async () => !(await portListening(port)), 10000, 'the port of the dead proxy to be free');

  writeInventory(w, 'ops', { ssh: [web1('ops')], kubernetes: [cluster(w, 'lab', port)] });
  let ops = await startedOf(w, 'ops');
  assert.deepEqual(skippedLines(ops), [`kube lab SKIPPED port ${port} is also used by project shop; give each project its own port`]);
  assert.equal(hasProxy(w, 'ops'), false);
  assert.equal(await stopWith(ops), 0);

  // shop's file no longer names the port, as when it was edited after shop started: its live session still does.
  writeInventory(w, 'shop', { ssh: [web1('shop')] });
  ops = await startedOf(w, 'ops');
  assert.deepEqual(skippedLines(ops), [`kube lab SKIPPED port ${port} is also used by project shop; give each project its own port`]);
  assert.equal(hasProxy(w, 'ops'), false);
  assert.equal(await portListening(port), false, 'nothing answers on the port');
  const listed = JSON.parse((await callTool('list_targets', {}, envOf(w, 'shop'))).text).targets;
  assert.deepEqual(listed.map((t) => [t.name, t.state]), [['web1', 'up'], ['lab', 'down']]);
  assert.equal(await stopWith(ops), 0);
  assert.equal(await stopWith(shop), 0);
});

test('a tunnel.localPort named in another file is refused the same way, in both directions; a free cluster opens', async () => {
  const w = await world();
  const [a, b, c, d, e, f] = await freePorts(6);
  const tunnel = (localPort) => ({ tunnel: { host: 'bastion1', localPort, remote: '127.0.0.1:6443' } });
  writeInventory(w, 'shop', { kubernetes: [cluster(w, 'lab', a, tunnel(b)), cluster(w, 'lab2', d, tunnel(e))] });
  writeInventory(w, 'ops', {
    ssh: [web1('ops')], kubernetes: [cluster(w, 'lab', c, tunnel(b)), cluster(w, 'lab2', e), cluster(w, 'lab3', f)],
  });
  const ops = await startedOf(w, 'ops');
  assert.deepEqual(skippedLines(ops), [
    `kube lab SKIPPED port ${b} is also used by project shop; give each project its own port`,
    `kube lab2 SKIPPED port ${e} is also used by project shop; give each project its own port`,
  ]);
  assert.deepEqual(states(w, 'ops'), ['ssh:web1:up', 'kubernetes:lab3:up']);
  assert.equal(await stopWith(ops), 0);
});

test('another inventory file that cannot be read or is not JSON refuses every cluster of this start; the other targets open', async () => {
  const w = await world();
  const [port, other] = await freePorts(2);
  const shopFile = { ssh: [web1('shop')], kubernetes: [cluster(w, 'lab', port), cluster(w, 'lab2', other)] };
  writeInventory(w, 'shop', shopFile);
  const cases = [
    [() => fs.mkdirSync(fileOf(w, 'ops')), fileOf(w, 'ops')],
    [() => { fs.rmdirSync(fileOf(w, 'ops')); writeRaw(w, 'ops', '{"kubernetes": ['); }, fileOf(w, 'ops')],
    [() => { fs.rmSync(fileOf(w, 'ops')); writeRaw(w, null, 'not json'); }, fileOf(w, null)],
  ];
  for (const [arrange, file] of cases) {
    arrange();
    const run = await startedOf(w, 'shop');
    assert.deepEqual(skippedLines(run), [
      `kube lab SKIPPED cannot read ${file} to check its ports`,
      `kube lab2 SKIPPED cannot read ${file} to check its ports`,
    ], file);
    assert.deepEqual(states(w, 'shop'), ['ssh:web1:up']);
    assert.equal(hasProxy(w, 'shop'), false);
    assert.equal(await stopWith(run), 0);
  }

  // For the default start the projects folder itself is read: a folder that cannot be listed refuses its clusters too.
  writeInventory(w, null, { ssh: [web1('default')], kubernetes: [cluster(w, 'lab', port)] });
  fs.rmSync(path.join(w.cfg, 'projects'), { recursive: true });
  fs.symlinkSync('projects', path.join(w.cfg, 'projects'));
  const own = await startedOf(w, null);
  assert.deepEqual(skippedLines(own), [`kube lab SKIPPED cannot read ${path.join(w.cfg, 'projects')} to check its ports`]);
  assert.deepEqual(states(w, null), ['ssh:web1:up']);
  assert.equal(await stopWith(own), 0);
});

test('a default user with one inventory file opens the cluster as before: no projects folder, no other session', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  writeInventory(w, null, { ssh: [web1('default')], kubernetes: [cluster(w, 'lab', port)] });
  assert.deepEqual(otherInventories(envOf(w, null)), { others: [], unreadable: null });
  assert.deepEqual(usedPorts(envOf(w, null)), { used: new Map(), unreadable: null });
  const own = await startedOf(w, null);
  assert.deepEqual(skippedLines(own), []);
  assert.deepEqual(states(w, null), ['ssh:web1:up', 'kubernetes:lab:up']);
  assert.equal(await stopWith(own), 0);
  // A file named projects, where the folder would be, holds no project file.
  fs.writeFileSync(path.join(w.cfg, 'projects'), '');
  assert.deepEqual(otherInventories(envOf(w, null)), { others: [], unreadable: null });
});

test('otherInventories reads every other file as JSON, skips its own and the missing ones, and stops at the first it cannot read', async () => {
  const w = await world();
  fs.rmSync(fileOf(w, null));
  writeInventory(w, 'shop', { kubernetes: [] });
  writeInventory(w, 'ops', { ssh: [] });
  // Names that break the project rule, or that are not .json files, are never project files.
  for (const odd of ['Bad.json', 'notes.txt', '-x.json', '.json']) fs.writeFileSync(path.join(w.cfg, 'projects', odd), 'not json');
  // A link to a file that is gone is a missing file, as for the default inventory.
  fs.symlinkSync(path.join(w.base, 'missing.json'), path.join(w.cfg, 'projects', 'gone.json'));
  assert.deepEqual(otherInventories(envOf(w, 'shop')), { others: [{ where: 'project ops', raw: { ssh: [] } }], unreadable: null });
  assert.deepEqual(otherInventories(envOf(w, null)), {
    others: [{ where: 'project ops', raw: { ssh: [] } }, { where: 'project shop', raw: { kubernetes: [] } }], unreadable: null,
  });
  writeInventory(w, null, { local: [] });
  assert.deepEqual(otherInventories(envOf(w, 'ops')).others.map((o) => o.where), ['the default inventory', 'project shop']);
  writeRaw(w, 'ops', '[');
  assert.deepEqual(otherInventories(envOf(w, 'shop')), {
    others: [{ where: 'the default inventory', raw: { local: [] } }], unreadable: fileOf(w, 'ops'),
  });
});

test('usedPorts takes the integer ports of the kind from every other file and every other live session, the first place wins', async () => {
  const w = await world();
  writeInventory(w, null, { kubernetes: [{ proxyPort: 2001, tunnel: { localPort: 2002 } }, null, { proxyPort: '2003' }, { tunnel: 'x' }] });
  writeRaw(w, 'ops', JSON.stringify([]));
  writeInventory(w, 'odd', { kubernetes: { proxyPort: 2004 } });
  writeInventory(w, 'web', { kubernetes: [{ proxyPort: 2001 }], ssh: [{ proxyPort: 2005 }] });
  const session = (dir, targets) => writeSession(dir, { version: 1, pid: process.pid, startedAt: 't', targets });
  session(path.join(stateOf(w, 'ops'), 'session'), [null, { kind: 'kubernetes', proxyPort: 2006 }, { kind: 'ssh', proxyPort: 2007 }, { kind: 'kubernetes', proxyPort: 2001 }]);
  session(path.join(stateOf(w, 'shop'), 'session'), [{ kind: 'kubernetes', proxyPort: 2008 }]);
  const { used, unreadable } = usedPorts(envOf(w, 'shop'));
  assert.equal(unreadable, null);
  assert.deepEqual([...used], [[2001, 'the default inventory'], [2002, 'the default inventory'], [2006, 'project ops']]);
  assert.deepEqual(liveSessions(envOf(w, 'shop')).map((live) => live.project), ['ops', 'shop']);

  const blocked = usedPorts(envOf(w, 'shop'), { others: [], unreadable: '/cfg/projects/x.json' });
  assert.equal(portProblem(kube, cluster(w, 'lab', 3000), blocked), 'cannot read /cfg/projects/x.json to check its ports');
  assert.equal(portProblem(kube, cluster(w, 'lab', 2006), { used, unreadable: null }), 'port 2006 is also used by project ops; give each project its own port');
  assert.equal(portProblem(kube, cluster(w, 'lab', 3000, { tunnel: { localPort: 2002 } }), { used, unreadable: null }), 'port 2002 is also used by the default inventory; give each project its own port');
  assert.equal(portProblem(kube, cluster(w, 'lab', 3000, { tunnel: null }), { used, unreadable: null }), null);
  assert.equal(portProblem(kindByKey('ssh'), web1('shop'), blocked), null, 'a kind without ports is never refused here');
});

test('init picks for the cluster sample the first ports from its own upward that no other file or live session uses', async () => {
  const w = await world();
  writeInventory(w, null, { kubernetes: [{ proxyPort: 8001, tunnel: { localPort: 16443 } }] });
  writeInventory(w, 'ops', { kubernetes: [{ proxyPort: 8002 }, { proxyPort: 16444 }] });
  const init = async (args) => {
    const proc = fakeProcess();
    assert.equal(await main(['init', ...args], w.env, { process: proc }), 0);
  };
  const sampleOf = (project) => JSON.parse(fs.readFileSync(fileOf(w, project), 'utf8')).kubernetes[0];
  await init(['--project', 'shop']);
  assert.deepEqual([sampleOf('shop').proxyPort, sampleOf('shop').tunnel.localPort], [8003, 16445]);
  await init(['--project=web']);
  assert.deepEqual([sampleOf('web').proxyPort, sampleOf('web').tunnel.localPort], [8004, 16446]);
  const { kubernetes, ...rest } = JSON.parse(fs.readFileSync(fileOf(w, 'web'), 'utf8'));
  const { kubernetes: plain, ...plainRest } = sampleInventory();
  assert.deepEqual(rest, plainRest);
  assert.deepEqual({ ...kubernetes[0], proxyPort: 8001, tunnel: { ...kubernetes[0].tunnel, localPort: 16443 } }, plain[0]);

  // The proxy port is taken before the tunnel port, so the two never meet.
  const taken = new Set(Array.from({ length: 16443 - 8001 }, (_, i) => 8001 + i));
  const [moved] = kube.freeSample(taken);
  assert.deepEqual([moved.proxyPort, moved.tunnel.localPort], [16443, 16444]);
  assert.equal(taken.size, 16443 - 8001, 'the set given is not changed');
  assert.deepEqual(kube.freeSample(new Set()), kube.sample);
  assert.deepEqual(kube.ports([{ proxyPort: 1, tunnel: { localPort: 2 } }, { proxyPort: 3, tunnel: null }, {}]), [1, 2, 3, undefined, undefined, undefined]);
});

test('without other files init writes the sample ports as before', async () => {
  const w = await world();
  fs.rmSync(fileOf(w, null));
  const proc = fakeProcess();
  assert.equal(await main(['init'], w.env, { process: proc }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(fileOf(w, null), 'utf8')), JSON.parse(JSON.stringify(sampleInventory())));
  assert.equal(JSON.parse(fs.readFileSync(fileOf(w, null), 'utf8')).kubernetes[0].proxyPort, 8001);
});
