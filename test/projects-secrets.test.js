import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { withProject } from '../src/paths.js';
import { everySecretFile, otherInventories, otherSecretFiles } from '../src/projects.js';
import { callTool } from '../src/tools.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

const QUIET = { KSPROXY_HEALTH_MS: '60000' };

after(() => cleanupAll());

// A world whose repo folder holds the kubeconfig of ops and the Kafka client file of the default inventory.
async function world() {
  const w = await makeWorld({ extraEnv: QUIET });
  w.cfg = w.env.KSPROXY_CONFIG_DIR;
  w.root = w.env.KSPROXY_STATE_DIR;
  w.repo = path.join(w.base, 'repo');
  fs.mkdirSync(path.join(w.repo, 'deploy'), { recursive: true });
  w.kubeconfig = path.join(w.repo, 'deploy', 'ops-agent.yaml');
  fs.writeFileSync(w.kubeconfig, 'token: OPS-MADE-UP-TOKEN-0000\n');
  w.clientFile = path.join(w.repo, 'deploy', 'client.properties');
  fs.writeFileSync(w.clientFile, 'sasl.password=MADE-UP-0000\n');
  w.elsewhere = path.join(w.base, 'elsewhere');
  fs.mkdirSync(w.elsewhere);
  fs.writeFileSync(path.join(w.elsewhere, 'a.txt'), 'a\n');
  return w;
}

const fileOf = (w, project) => (project === null ? path.join(w.cfg, 'inventory.json') : path.join(w.cfg, 'projects', `${project}.json`));

function writeRaw(w, project, text) {
  fs.mkdirSync(path.dirname(fileOf(w, project)), { recursive: true });
  fs.writeFileSync(fileOf(w, project), text);
}

const writeInventory = (w, project, inventory) => writeRaw(w, project, JSON.stringify(inventory));
const web1 = { name: 'web1', host: 'web1.example.com', allow: ['uptime'] };
const local = (name, cwd) => ({ name, cwd, allow: ['cat *', 'cat deploy/ops-agent.yaml'] });
const kafka = (w) => ({ name: 'events', bootstrap: 'kafka1.example:9093', clientConfig: w.clientFile, allow: ['topics --list'] });
const skippedLines = (run) => run.proc.stderr.text.split('\n').filter((line) => /SKIPPED/.test(line))
  .map((line) => line.replace(/^\S+ /, '').replace(/ +/g, ' '));

async function check(w, args) {
  const proc = fakeProcess();
  const code = await main(['check', ...args], w.env, { process: proc });
  return { code, out: proc.stdout.text, err: proc.stderr.text };
}

test('a local target never opens on a folder that holds a file another inventory file names, and check says the same', async () => {
  const w = await world();
  writeInventory(w, null, { ssh: [web1], kafka: [kafka(w)] });
  writeInventory(w, 'ops', { kubernetes: [{ name: 'lab', kubeconfig: w.kubeconfig, proxyPort: 8001, allow: ['get ...'] }] });
  writeInventory(w, 'shop', { ssh: [web1], local: [local('infra', w.repo)] });

  const shop = launch({ env: withProject(w.env, 'shop') }, { all: true });
  await ready(shop);
  assert.deepEqual(skippedLines(shop), ['loc infra SKIPPED folder contains a kubeconfig named in the inventory']);
  const refused = await callTool('local_exec', { target: 'infra', command: 'cat deploy/ops-agent.yaml' }, withProject(w.env, 'shop'));
  assert.equal(refused.isError, true);
  assert.ok(!refused.text.includes('OPS-MADE-UP-TOKEN'), refused.text);
  assert.equal(await stopWith(shop), 0);
  const checked = await check(w, ['--project', 'shop', 'local', 'infra', 'cat', 'deploy/ops-agent.yaml']);
  assert.deepEqual(checked, { code: 1, out: 'REFUSED: folder contains a kubeconfig named in the inventory\n', err: '' });

  // The Kafka client file of the default inventory alone keeps the folder closed too.
  writeInventory(w, 'ops', { ssh: [web1] });
  const again = launch({ env: withProject(w.env, 'shop') }, { all: true });
  await ready(again);
  assert.deepEqual(skippedLines(again), ['loc infra SKIPPED folder contains a kubeconfig named in the inventory']);
  assert.equal(await stopWith(again), 0);

  // And the other way round: the default start never opens a folder that holds a file a project file names.
  writeInventory(w, null, { ssh: [web1], local: [local('infra', w.repo)] });
  writeInventory(w, 'ops', { kafka: [kafka(w)] });
  const own = launch({ env: withProject(w.env, null) }, { all: true });
  await ready(own);
  assert.deepEqual(skippedLines(own), ['loc infra SKIPPED folder contains a kubeconfig named in the inventory']);
  assert.equal(await stopWith(own), 0);
  assert.equal((await check(w, ['local', 'infra', 'cat', 'deploy/client.properties'])).out, 'REFUSED: folder contains a kubeconfig named in the inventory\n');
});

test('the session of a local target records the files that every inventory file names, so a call can never reach them', async () => {
  const w = await world();
  writeInventory(w, null, { kafka: [kafka(w)] });
  writeInventory(w, 'ops', { kubernetes: [{ name: 'lab', kubeconfig: w.kubeconfig, proxyPort: 8001, allow: ['get ...'] }] });
  writeInventory(w, 'shop', { local: [local('infra', w.elsewhere)] });
  const shop = launch({ env: withProject(w.env, 'shop') }, { all: true });
  await ready(shop);
  const session = JSON.parse(fs.readFileSync(path.join(w.root, 'p', 'shop', 'session', 'session.json'), 'utf8'));
  const [infra] = session.targets;
  assert.ok(infra.protected.includes(w.kubeconfig), infra.protected.join(' '));
  assert.ok(infra.protected.includes(w.clientFile), infra.protected.join(' '));
  const ok = await callTool('local_exec', { target: 'infra', command: 'cat a.txt' }, withProject(w.env, 'shop'));
  assert.equal(ok.text, 'exit code: 0\n--- stdout ---\na');
  assert.equal(await stopWith(shop), 0);
  assert.equal((await check(w, ['--project', 'shop', 'local', 'infra', 'cat', 'a.txt'])).out, 'ALLOWED by rule: cat *\n');
});

test('another inventory file that cannot be read or is not JSON skips every local target of this start; check refuses the same way', async () => {
  const w = await world();
  writeInventory(w, 'shop', { ssh: [web1], local: [local('infra', w.elsewhere), local('docs', w.repo)] });
  const cases = [
    [() => writeRaw(w, 'ops', '{"kubernetes": ['), fileOf(w, 'ops')],
    [() => { fs.rmSync(fileOf(w, 'ops')); fs.mkdirSync(fileOf(w, null), { recursive: true }); }, fileOf(w, null)],
  ];
  fs.rmSync(fileOf(w, null));
  for (const [arrange, file] of cases) {
    arrange();
    const message = `cannot read ${file} to protect the files it names`;
    const shop = launch({ env: withProject(w.env, 'shop') }, { all: true });
    await ready(shop);
    assert.deepEqual(skippedLines(shop), [`loc infra SKIPPED ${message}`, `loc docs SKIPPED ${message}`], file);
    assert.equal(await stopWith(shop), 0);
    assert.deepEqual(await check(w, ['--project', 'shop', 'local', 'infra', 'cat', 'a.txt']), { code: 1, out: `REFUSED: ${message}\n`, err: '' });
    // A kind that does not protect files is checked as before.
    assert.equal((await check(w, ['--project', 'shop', 'ssh', 'web1', 'uptime'])).out, 'ALLOWED by rule: uptime\n');
  }
});

test('otherSecretFiles keeps what secretFiles of each kind gives for the other files, as absolute paths', async () => {
  const w = await world();
  writeInventory(w, null, {
    kubernetes: [{ kubeconfig: '/k/./a.yaml' }, { kubeconfig: '~/k/b.yaml' }, { kubeconfig: 'relative.yaml' }, { kubeconfig: '' }, { kubeconfig: 5 }, {}, null],
    kafka: [{ clientConfig: '/k/c/../c.properties' }, { name: 'no-file' }],
  });
  writeInventory(w, 'ops', { kubernetes: { kubeconfig: '/k/not-a-list.yaml' } });
  writeRaw(w, 'web', '"a string"');
  writeInventory(w, 'shop', { kubernetes: [{ kubeconfig: '/k/own.yaml' }] });
  const inventories = otherInventories(withProject(w.env, 'shop'));
  assert.deepEqual(otherSecretFiles(inventories), ['/k/a.yaml', path.join(os.homedir(), 'k', 'b.yaml'), '/k/c.properties']);
  const own = { kubernetes: [{ kubeconfig: '/k/own.yaml' }], kafka: [] };
  for (const kind of ['ssh', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb']) own[kind] = [];
  assert.deepEqual(everySecretFile(own, inventories), {
    files: ['/k/own.yaml', '/k/a.yaml', path.join(os.homedir(), 'k', 'b.yaml'), '/k/c.properties'], problem: null,
  });
  assert.deepEqual(everySecretFile(own, { others: [], unreadable: '/cfg/x.json' }), {
    files: ['/k/own.yaml'], problem: 'cannot read /cfg/x.json to protect the files it names',
  });
});

test('a secret file named only in projects/default.json is in everySecretFile, for the default and for a project', async () => {
  const w = await world();
  writeInventory(w, null, { ssh: [web1] });
  writeInventory(w, 'default', { kubernetes: [{ name: 'old', kubeconfig: '/k/old-default.yaml', proxyPort: 8021, allow: ['get ...'] }] });
  writeInventory(w, 'shop', { ssh: [web1] });
  const own = {};
  for (const kind of ['ssh', 'kubernetes', 'kafka', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb']) own[kind] = [];
  for (const env of [w.env, withProject(w.env, 'shop'), withProject(w.env, 'default')]) {
    assert.deepEqual(everySecretFile(own, otherInventories(env)), { files: ['/k/old-default.yaml'], problem: null });
  }
});
