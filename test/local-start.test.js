import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { readAuditEntries } from '../src/audit.js';
import {
  cleanupAll, fakeProcess, launch, listenerTotal, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

after(() => cleanupAll());

const sessionOf = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));

test('--local opens a folder, records it in the session with the absolute PATH entries of the start process, and closes with nothing to clean up', async () => {
  const world = await makeWorld({ ssh: [], local: [{}] });
  const run = launch(world, { local: ['infra'] });
  await ready(run);

  const err = run.proc.stderr.text;
  assert.ok(err.includes(`loc  infra      OPENING         ${world.proj}\n`), err);
  assert.match(err, /loc {2}infra +UP\n/);
  assert.match(run.proc.stdout.text, /READY +1 targets, pid \d+/);

  const session = sessionOf(world);
  assert.deepEqual(session.targets, [{
    kind: 'local',
    name: 'infra',
    description: 'a repo',
    allow: ['ls ...', 'cat *'],
    cwd: world.proj,
    path: world.env.PATH.split(':').filter((entry) => entry.startsWith('/')).join(':'),
    protected: [world.env.KSPROXY_STATE_DIR, world.env.KSPROXY_CONFIG_DIR],
    state: 'up',
  }]);
  const agentMd = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.match(agentMd, /^### Local folder `infra` - a repo$/m);
  assert.ok(!agentMd.includes(world.proj));
  assert.equal(fs.statSync(path.join(world.sessionDir, 'session.json')).mode & 0o777, 0o600);

  const ok = await callTool('local_exec', { target: 'infra', command: 'cat a.txt' }, world.env);
  assert.equal(ok.isError, false, ok.text);
  assert.ok(ok.text.includes('hello a'));
  const denied = await callTool('local_exec', { target: 'infra', command: 'cat /etc/hosts' }, world.env);
  assert.equal(denied.isError, true);
  await waitFor(() => /DENIED/.test(run.proc.stdout.text), 10000, 'the call lines');
  assert.match(run.proc.stdout.text, /loc {2}infra +ok .*cat a\.txt/);
  assert.match(run.proc.stdout.text, /loc {2}infra +DENIED +cat \/etc\/hosts {2}\[not a plain argument\]/);

  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSED +2 calls: 1 ok, 0 failed, 1 denied/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.equal(listenerTotal(run.proc), 0);
  const events = readAuditEntries(world.auditLog).map(({ entry }) => entry);
  assert.deepEqual(events.find((e) => e.event === 'session_start').targets, [{ kind: 'loc', name: 'infra', state: 'up' }]);
  assert.ok(events.filter((e) => e.event === 'call').every((e) => e.kind === 'loc'));
});

test('a session edited to carry allowOutsidePaths: true is treated like any other: the key is ignored', async () => {
  const world = await makeWorld({ ssh: [], local: [{}] });
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  const file = path.join(world.sessionDir, 'session.json');
  const session = sessionOf(world);
  assert.equal('allowOutsidePaths' in session.targets[0], false);
  session.targets[0].allowOutsidePaths = true;
  fs.writeFileSync(file, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  const absolute = await callTool('local_exec', { target: 'infra', command: 'cat /etc/hosts' }, world.env);
  assert.equal(absolute.isError, true);
  assert.match(absolute.text, /^REFUSED \(local infra\): the argument \/etc\/hosts is not a plain name or path/);
  fs.symlinkSync('/etc/hosts', path.join(world.proj, 'hostslink'));
  const link = await callTool('local_exec', { target: 'infra', command: 'cat hostslink' }, world.env);
  assert.equal(link.isError, true);
  assert.match(link.text, /points outside this target's folder/);
  assert.equal(await stopWith(run), 0);
});

test('every kubeconfig of the inventory, selected or not, is recorded as protected, and never listed to the agent', async () => {
  const world = await makeWorld({ ssh: [], kubernetes: [{ name: 'lab' }, { name: 'other' }], local: [{}] });
  const second = path.join(world.base, 'kube-two.yaml');
  fs.writeFileSync(second, 'apiVersion: v1\n');
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.kubernetes[1].kubeconfig = second;
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  const [t] = sessionOf(world).targets;
  assert.deepEqual(t.protected, [world.kubeconfig, second, world.env.KSPROXY_STATE_DIR, world.env.KSPROXY_CONFIG_DIR]);
  const listed = await callTool('list_targets', {}, world.env);
  assert.ok(!listed.text.includes('protected'), listed.text);
  assert.ok(!listed.text.includes(second), listed.text);
  for (const [i, file] of [world.kubeconfig, second].entries()) {
    fs.symlinkSync(file, path.join(world.proj, `kube-link-${i}`));
    const denied = await callTool('local_exec', { target: 'infra', command: `cat kube-link-${i}` }, world.env);
    assert.equal(denied.isError, true);
    assert.match(denied.text, /ksproxy's own files are off limits/);
  }
  assert.equal(await stopWith(run), 0);
});

test('a start process without PATH records the default one', async () => {
  const world = await makeWorld({ ssh: [], local: [{}] });
  const env = { ...world.env };
  delete env.PATH;
  const proc = fakeProcess();
  const run = launch({ ...world, env }, { local: ['infra'] }, { process: proc });
  await ready(run);
  assert.equal(sessionOf(world).targets[0].path, '/usr/bin:/bin');
  assert.equal(await stopWith(run), 0);
});

test('the PATH recorded by start has no relative or empty entry and none inside the folder', async () => {
  const world = await makeWorld({ ssh: [], local: [{}] });
  const env = { ...world.env, PATH: `.:${path.join(world.proj, 'bin')}::node_modules/.bin:/usr/bin:${world.proj}:/bin` };
  const run = launch({ ...world, env }, { local: ['infra'] });
  await ready(run);
  assert.equal(sessionOf(world).targets[0].path, '/usr/bin:/bin');
  assert.equal(await stopWith(run), 0);
});

test('the PATH recorded for every local target leaves out entries inside any of the selected folders', async () => {
  const world = await makeWorld({ ssh: [], local: [{}, { name: 'second', cwd: '/tmp/placeholder' }] });
  const second = path.join(world.base, 'second');
  fs.mkdirSync(path.join(second, 'bin'), { recursive: true });
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.local[1].cwd = second;
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
  const env = { ...world.env, PATH: `${path.join(second, 'bin')}:${path.join(world.proj, 'bin')}:/usr/bin:${world.base}/elsewhere:/bin` };
  const run = launch({ ...world, env }, { local: ['infra', 'second'] });
  await ready(run);
  const targets = sessionOf(world).targets;
  assert.deepEqual(targets.map((t) => t.name), ['infra', 'second']);
  for (const t of targets) assert.equal(t.path, `/usr/bin:${world.base}/elsewhere:/bin`, t.name);
  assert.equal(await stopWith(run), 0);
});

test('a session written with its own config folder keeps protecting it from a reader that does not know it', async () => {
  const world = await makeWorld({ ssh: [], local: [{ allow: ['cat *'] }] });
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  const reader = { ...process.env, KSPROXY_STATE_DIR: world.env.KSPROXY_STATE_DIR };
  delete reader.KSPROXY_CONFIG_DIR;
  fs.symlinkSync(world.env.KSPROXY_CONFIG_DIR, path.join(world.proj, 'cfglink'));
  const denied = await callTool('local_exec', { target: 'infra', command: 'cat cfglink/inventory.json' }, reader);
  assert.equal(denied.isError, true);
  assert.equal(denied.text, "REFUSED (local infra): ksproxy's own files are off limits");
  assert.equal(await stopWith(run), 0);
});

test('a missing folder and a file instead of a folder are skipped with their reason', async () => {
  const world = await makeWorld({
    ssh: [],
    local: [
      { name: 'gone', cwd: '/tmp/ks-sp-no-such-folder-here' },
      { name: 'file', cwd: path.join('/tmp', 'placeholder') },
      { name: 'good' },
    ],
  });
  const file = path.join(world.proj, 'a.txt');
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.local[1].cwd = file;
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));

  const run = launch(world, { local: ['gone', 'file', 'good'] });
  await ready(run);
  const err = run.proc.stderr.text;
  assert.match(err, /loc {2}gone +SKIPPED +folder not found: \/tmp\/ks-sp-no-such-folder-here\n/);
  assert.ok(err.includes(`SKIPPED         not a directory: ${file}\n`), err);
  assert.match(err, /loc {2}good +UP\n/);
  assert.deepEqual(sessionOf(world).targets.map((t) => t.name), ['good']);
  assert.equal(await stopWith(run), 0);
});

test('a local folder that contains a kubeconfig of the inventory is skipped with that reason', async () => {
  const world = await makeWorld({ ssh: [], kubernetes: [{}], local: [{ name: 'bad' }, { name: 'good', cwd: path.join('/tmp', 'placeholder') }] });
  const good = path.join(world.base, 'good-dir');
  fs.mkdirSync(good);
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.kubernetes[0].kubeconfig = path.join(world.proj, 'kube-inside.yaml');
  inventory.local[1].cwd = good;
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
  const run = launch(world, { local: ['bad', 'good'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /loc {2}bad +SKIPPED +folder contains a kubeconfig named in the inventory\n/);
  assert.match(run.proc.stderr.text, /loc {2}good +UP\n/);
  assert.deepEqual(sessionOf(world).targets.map((t) => t.name), ['good']);
  assert.equal(await stopWith(run), 0);
});

test('when the only local target cannot be opened, nothing could be opened', async () => {
  const world = await makeWorld({ ssh: [], local: [{ cwd: '/tmp/ks-sp-no-such-folder-here' }] });
  const run = launch(world, { local: ['infra'] });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /SKIPPED +folder not found/);
  assert.match(run.proc.stderr.text, /nothing could be opened\n$/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
});

test('an empty allowlist is warned about before the folder opens', async () => {
  const world = await makeWorld({ ssh: [], local: [{ allow: [] }] });
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /loc {2}infra +WARN +allowlist is empty, every command will be refused\n/);
  assert.equal(await stopWith(run), 0);
});

test('--all includes local targets after ssh and clusters', async () => {
  const world = await makeWorld({ kubernetes: [{}], local: [{}] });
  const run = launch(world, { all: true });
  await ready(run);
  assert.deepEqual(sessionOf(world).targets.map((t) => `${t.kind}:${t.name}`), ['ssh:web1', 'kubernetes:lab', 'local:infra']);
  assert.match(run.proc.stdout.text, /READY +3 targets/);
  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSED/);
  assert.deepEqual(fs.readdirSync(world.socketDir), []);
});

test('--local names are checked against the inventory', async () => {
  const world = await makeWorld({ local: [{}] });
  let run = launch(world, { local: ['nope'] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'unknown local target "nope"; known local targets: infra\n');

  const none = await makeWorld();
  run = launch(none, { local: ['x'] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'unknown local target "x"; known local targets: none\n');

  run = launch(world, { local: [] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'nothing selected\n');
});

test('without a terminal and without a selection start names --local too', async () => {
  const world = await makeWorld({ local: [{}] });
  const run = launch(world, {});
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'no targets selected: use --ssh, --kube, --local or --all when not running in a terminal\n');
});

test('on a terminal the three kinds are offered, in the order ssh, kubernetes, local', async () => {
  const world = await makeWorld({ kubernetes: [{}], local: [{}, { name: 'other', description: '' }] });
  const asked = [];
  const answers = [[2], [1]];
  const checkbox = async (request) => {
    asked.push(request);
    return answers.shift();
  };
  const proc = fakeProcess();
  proc.stdin.isTTY = true;
  const run = launch(world, {}, { process: proc, checkbox });
  await ready(run);
  assert.deepEqual(asked.map((a) => a.title), ['Which kinds of proxy?', 'Which local targets?']);
  assert.deepEqual(asked[0].items, [
    { key: 'ssh', label: 'ssh', hint: '1 server(s)' },
    { key: 'kubernetes', label: 'kubernetes', hint: '1 cluster(s)' },
    { key: 'local', label: 'local', hint: '2 folder(s)' },
  ]);
  assert.deepEqual(asked[1].items, [
    { label: 'infra', hint: `${world.proj} — a repo` },
    { label: 'other', hint: world.proj },
  ]);
  assert.deepEqual(sessionOf(world).targets.map((t) => t.name), ['other']);
  assert.equal(await stopWith(run), 0);
});

test('with only local targets there is no kind question', async () => {
  const world = await makeWorld({ ssh: [], local: [{}] });
  const asked = [];
  const proc = fakeProcess();
  proc.stdin.isTTY = true;
  const run = launch(world, {}, {
    process: proc,
    checkbox: async (request) => {
      asked.push(request.title);
      return [0];
    },
  });
  await ready(run);
  assert.deepEqual(asked, ['Which local targets?']);
  assert.equal(await stopWith(run), 0);
});

test('a stop requested while targets are opening skips the local folders still to open', async () => {
  const early = await makeWorld({ local: [{}] });
  let proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/ssh {2}web1 +UP/.test(text)) proc.emit('SIGINT');
  };
  let run = launch(early, { all: true }, { process: proc });
  assert.equal(await run.done, 0);
  assert.ok(!/loc /.test(proc.stderr.text), proc.stderr.text);
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C/);
  assert.equal(fs.existsSync(path.join(early.sessionDir, 'session.json')), false);

  const between = await makeWorld({ ssh: [], local: [{}, { name: 'second' }] });
  proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/loc {2}infra +UP/.test(text)) proc.emit('SIGINT');
  };
  run = launch(between, { all: true }, { process: proc });
  assert.equal(await run.done, 0);
  assert.ok(!/second/.test(proc.stderr.text), proc.stderr.text);
  assert.match(proc.stderr.text, /CLOSED +0 calls/);
  assert.equal(fs.existsSync(path.join(between.sessionDir, 'session.json')), false);
});

test('the health check reports a folder that disappears and one that comes back', async () => {
  const world = await makeWorld({ ssh: [], local: [{}] });
  const folder = path.join(world.base, 'watched');
  fs.mkdirSync(folder);
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.local[0].cwd = folder;
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));

  const run = launch(world, { local: ['infra'] });
  await ready(run);
  fs.rmSync(folder, { recursive: true });
  await waitFor(() => /loc {2}infra +DOWN +folder is gone\n/.test(run.proc.stderr.text), 10000, 'the DOWN line');
  fs.mkdirSync(folder);
  await waitFor(() => /loc {2}infra +UP +folder is back\n/.test(run.proc.stderr.text), 10000, 'the UP line');
  assert.equal(await stopWith(run), 0);
});

function pointAt(world, folder, index = 0) {
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.local[index].cwd = folder;
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
}

test('a folder that holds ksproxy\'s folders, or lies inside them, is skipped as overlapping', async () => {
  for (const pick of [(w) => w.base, (w) => path.join(w.base, 'st'), (w) => w.env.KSPROXY_CONFIG_DIR]) {
    const world = await makeWorld({ ssh: [], local: [{}] });
    fs.mkdirSync(path.join(world.base, 'st'), { recursive: true });
    pointAt(world, pick(world));
    const run = launch(world, { local: ['infra'] });
    assert.equal(await run.done, 1);
    assert.match(run.proc.stderr.text, /loc {2}infra +SKIPPED +folder overlaps ksproxy's own files\n/);
    assert.match(run.proc.stderr.text, /nothing could be opened\n$/);
    assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  }
});

test('the home directory and the root are skipped as too broad, a link to nowhere as not found, and the others still open', async () => {
  const world = await makeWorld({
    ssh: [],
    local: [{ name: 'home' }, { name: 'root' }, { name: 'nowhere' }, { name: 'good' }],
  });
  const home = path.join(world.base, 'home');
  const dangling = path.join(world.base, 'dangling');
  assert.ok(fs.statSync(home).isDirectory(), 'makeWorld gives the world its own home folder');
  fs.symlinkSync(path.join(world.base, 'no-such-target'), dangling);
  pointAt(world, home, 0);
  pointAt(world, '/', 1);
  pointAt(world, dangling, 2);

  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const run = launch(world, { local: ['home', 'root', 'nowhere', 'good'] });
    await ready(run);
    const err = run.proc.stderr.text;
    assert.ok(err.includes(`SKIPPED         folder is too broad: pick a project folder, not ${home}\n`), err);
    assert.ok(err.includes('SKIPPED         folder is too broad: pick a project folder, not /\n'), err);
    assert.ok(err.includes(`SKIPPED         folder not found: ${dangling}\n`), err);
    assert.match(err, /loc {2}good +UP\n/);
    assert.deepEqual(sessionOf(world).targets.map((t) => t.name), ['good']);
    assert.equal(await stopWith(run), 0);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});
