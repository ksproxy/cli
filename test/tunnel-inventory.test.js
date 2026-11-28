import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import vault from './fixtures/kind-brokered.js';
import { exchange, startService } from './fixtures/kind-tunnelled.js';
import { KINDS, kindByKey } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, tunnelRoute, validateInventory } from '../src/inventory.js';
import { agentMdText } from '../src/agent-md.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

// A stand-in for a kind that can be tunnelled: the test vault with the two hooks, and a doctor hook (the trial of
// start) that sends PING through the stream. No real kind has them yet.
const problems = [];
const routed = {
  ...vault,
  tunnelTo: () => 'vault.example.com:8200',
  async doctor(opened, { signal }) {
    const reply = await exchange(opened.tunnel, 'PING', signal);
    return { ok: reply === 'PONG', detail: reply ?? 'no answer' };
  },
  tunnelProblem(target) {
    problems.push(target);
    return target.description === 'refuse me' ? 'cannot be used with this test setting' : null;
  },
};
KINDS.push(routed);
const service = await startService();
after(async () => {
  KINDS.splice(KINDS.indexOf(routed), 1);
  cleanupAll();
  await service.close();
});

const HOST = 'bastion1';
const JUMP = 'ssh -i .ssh/app_key opsuser@192.0.2.10';
// The parts of the route that must never reach the agent.
const ROUTE_PARTS = [HOST, 'app_key', 'opsuser', '192.0.2.10'];
const JUMP_PARTS = ['app_key', 'opsuser', '192.0.2.10'];
const VAULT = {
  name: 'v1', tokenEnv: 'VAULT_TEST_TOKEN', description: 'test vault', allow: ['read *'],
};
const TUNNEL = { host: HOST, jumps: [JUMP] };

const refused = (raw) => {
  try {
    validateInventory(raw);
  } catch (err) {
    assert.ok(err instanceof InventoryError, err.message);
    return err.message;
  }
  return assert.fail('was accepted');
};

test('the stand-in kind meets the contract', () => {
  checkKind(routed, KINDS);
});

test('a kind with tunnelTo: tunnel is taken off before validate and kept beside the target', () => {
  problems.length = 0;
  const withRoute = validateInventory({ vault: [{ ...VAULT, tunnel: TUNNEL }] });
  const without = validateInventory({ vault: [VAULT] });
  assert.deepEqual(withRoute.vault, without.vault);
  assert.deepEqual(withRoute, without);
  assert.deepEqual(tunnelRoute(withRoute, 'vault', 'v1'), { host: HOST, jumps: [JUMP] });
  assert.equal(tunnelRoute(without, 'vault', 'v1'), null);
  // tunnelProblem saw the validated target, once.
  assert.deepEqual(problems, [withRoute.vault[0]]);
});

test('a route without jumps, a route with spaces in a jump, and a route with maxOutputKiB', () => {
  const inventory = validateInventory({
    vault: [
      { ...VAULT, tunnel: { host: HOST } },
      { ...VAULT, name: 'v2', tunnel: { host: 'web1.example.com', jumps: ['ssh   -p 2222  ops@192.0.2.20', 'ssh ops@192.0.2.30'] } },
      { ...VAULT, name: 'v3', maxOutputKiB: 512, tunnel: { host: HOST, jumps: [] } },
      { ...VAULT, name: 'v4' },
    ],
  });
  assert.deepEqual(tunnelRoute(inventory, 'vault', 'v1'), { host: HOST, jumps: [] });
  assert.deepEqual(tunnelRoute(inventory, 'vault', 'v2'), { host: 'web1.example.com', jumps: ['ssh -p 2222 ops@192.0.2.20', 'ssh ops@192.0.2.30'] });
  assert.deepEqual(tunnelRoute(inventory, 'vault', 'v3'), { host: HOST, jumps: [] });
  assert.equal(inventory.vault[2].maxOutputKiB, 512);
  assert.equal(tunnelRoute(inventory, 'vault', 'v4'), null);
  assert.equal(tunnelRoute(inventory, 'vault', 'nope'), null);
  assert.equal(tunnelRoute(inventory, 'nope', 'v1'), null);
});

test('a route cannot be changed after it was validated', () => {
  const inventory = validateInventory({ vault: [{ ...VAULT, tunnel: TUNNEL }] });
  const route = tunnelRoute(inventory, 'vault', 'v1');
  assert.ok(Object.isFrozen(route));
  assert.ok(Object.isFrozen(route.jumps));
  assert.throws(() => { route.host = 'other'; }, TypeError);
  assert.throws(() => { route.jumps.push('ssh x@y'); }, TypeError);
});

test('tunnelRoute refuses an object that validateInventory did not give, a copy of one included', () => {
  const inventory = validateInventory({ vault: [{ ...VAULT, tunnel: TUNNEL }] });
  const text = 'tunnelRoute: not an inventory that validateInventory gave';
  assert.throws(() => tunnelRoute({ ...inventory }, 'vault', 'v1'), { message: text });
  assert.throws(() => tunnelRoute(structuredClone(inventory), 'vault', 'v1'), { message: text });
  assert.throws(() => tunnelRoute({}, 'vault', 'v1'), { message: text });
  assert.equal(tunnelRoute(validateInventory({}), 'vault', 'v1'), null);
});

test('every refusal of a route on a kind with tunnelTo, with its exact text', () => {
  const at = (tunnel) => refused({ vault: [{ ...VAULT, tunnel }] });
  assert.equal(at('bastion1'), 'vault "v1": tunnel: must be an object with "host" and optional "jumps"');
  assert.equal(at(null), 'vault "v1": tunnel: must be an object with "host" and optional "jumps"');
  assert.equal(at({ host: HOST, nope: 1 }), 'vault "v1": tunnel: unknown key "nope"');
  assert.equal(at({ jumps: [] }), 'vault "v1": tunnel.host: must match /^[A-Za-z0-9][A-Za-z0-9._@-]*$/ (no leading "-")');
  assert.equal(at({ host: '-oProxyCommand=x' }), 'vault "v1": tunnel.host: must match /^[A-Za-z0-9][A-Za-z0-9._@-]*$/ (no leading "-")');
  assert.equal(at({ host: HOST, jumps: 'ssh a@b' }), 'vault "v1": tunnel.jumps: must be a list of 0 to 5 ssh commands');
  assert.equal(at({ host: HOST, jumps: Array(6).fill('ssh a@b') }), 'vault "v1": tunnel.jumps: must be a list of 0 to 5 ssh commands');
  assert.equal(at({ host: HOST, jumps: [' '] }), 'vault "v1": tunnel.jumps[0]: must be an ssh command, for example "ssh -i .ssh/key user@server"');
  assert.equal(at({ host: HOST, jumps: ['ssh a@b', 'ssh -i ~/k a@b'] }), 'vault "v1": tunnel.jumps[1]: "~" is not allowed; a path without a leading "/" starts in the home folder of that login');
  assert.match(at({ host: HOST, jumps: ['scp a@b'] }), /^vault "v1": tunnel\.jumps\[0\]: /);
});

test('tunnelProblem: a text it gives is an inventory error for that target', () => {
  assert.equal(
    refused({ vault: [VAULT, { ...VAULT, name: 'v2', description: 'refuse me', tunnel: TUNNEL }] }),
    'vault "v2": tunnel: cannot be used with this test setting',
  );
  // Without a tunnel the same target is not asked.
  problems.length = 0;
  assert.doesNotThrow(() => validateInventory({ vault: [{ ...VAULT, description: 'refuse me' }] }));
  assert.deepEqual(problems, []);
});

test('a kind with tunnelTo and no tunnelProblem takes a route', () => {
  const plain = { ...routed, tunnelProblem: undefined };
  KINDS.splice(KINDS.indexOf(routed), 1, plain);
  try {
    const inventory = validateInventory({ vault: [{ ...VAULT, description: 'refuse me', tunnel: TUNNEL }] });
    assert.deepEqual(tunnelRoute(inventory, 'vault', 'v1'), { host: HOST, jumps: [JUMP] });
  } finally {
    KINDS.splice(KINDS.indexOf(plain), 1, routed);
  }
});

test('the other checks come in their order: maxOutputKiB, then the route, then the kind, then tunnelProblem', () => {
  assert.equal(
    refused({ vault: [{ ...VAULT, maxOutputKiB: 1, tunnel: 'x' }] }),
    'vault "v1": maxOutputKiB: must be an integer from 256 to 4096',
  );
  assert.equal(
    refused({ vault: [{ ...VAULT, tokenEnv: 'bad', tunnel: 'x' }] }),
    'vault "v1": tunnel: must be an object with "host" and optional "jumps"',
  );
  assert.match(
    refused({ vault: [{ ...VAULT, tokenEnv: 'bad', description: 'refuse me', tunnel: TUNNEL }] }),
    /^vault "v1": tokenEnv: /,
  );
});

test('a brokered kind without tunnelTo: tunnel is refused, for every such kind of this step', () => {
  for (const key of ['kafka', 'command', 'mcp']) {
    const kind = kindByKey(key);
    assert.equal(kind.tunnelTo, undefined, key);
    const [sample] = kind.sample;
    assert.equal(refused({ [key]: [{ ...sample, tunnel: TUNNEL }] }), `${key} "${sample.name}": this kind cannot use a tunnel`);
    // Even a broken route or an entry that is broken otherwise gives this text first.
    assert.equal(refused({ [key]: [{ ...sample, allow: 5, tunnel: 'x' }] }), `${key} "${sample.name}": this kind cannot use a tunnel`);
  }
  const bare = { ...routed, tunnelTo: undefined, tunnelProblem: undefined };
  KINDS.splice(KINDS.indexOf(routed), 1, bare);
  try {
    assert.equal(refused({ vault: [{ ...VAULT, tunnel: TUNNEL }] }), 'vault "v1": this kind cannot use a tunnel');
  } finally {
    KINDS.splice(KINDS.indexOf(bare), 1, routed);
  }
});

test('http, elasticsearch and rabbitmq take a route: the target is the same as without it, and the route is beside it', () => {
  for (const key of ['http', 'elasticsearch', 'rabbitmq']) {
    const [sample] = kindByKey(key).sample;
    const withRoute = validateInventory({ [key]: [{ ...sample, tunnel: TUNNEL }] });
    const without = validateInventory({ [key]: [sample] });
    assert.deepEqual(withRoute, without, key);
    assert.deepEqual(tunnelRoute(withRoute, key, sample.name), { host: HOST, jumps: [JUMP] }, key);
    assert.equal(tunnelRoute(without, key, sample.name), null, key);
    // A broken route is refused as on any kind that takes one.
    assert.equal(refused({ [key]: [{ ...sample, tunnel: 'x' }] }), `${key} "${sample.name}": tunnel: must be an object with "host" and optional "jumps"`);
  }
  // No sample of these kinds has a route: ksproxy init writes none.
  for (const key of ['http', 'elasticsearch', 'rabbitmq']) assert.equal(kindByKey(key).sample.some((entry) => 'tunnel' in entry), false);
});

test('ssh and local refuse tunnel as an unknown key, as before; kubernetes keeps its own tunnel', () => {
  assert.equal(
    refused({ ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['uptime'], tunnel: TUNNEL }] }),
    'ssh "web1": unknown key "tunnel"',
  );
  assert.equal(
    refused({ local: [{ name: 'infra', cwd: '/srv/infra', allow: ['git status'], tunnel: TUNNEL }] }),
    'local "infra": unknown key "tunnel"',
  );
  const kube = {
    name: 'lab', kubeconfig: '/srv/kube/lab.yaml', proxyPort: 18001, allow: ['get ...'],
  };
  const inventory = validateInventory({ kubernetes: [{ ...kube, tunnel: { host: HOST, localPort: 16443, remote: '127.0.0.1:6443' } }] });
  assert.deepEqual(inventory.kubernetes[0].tunnel, { host: HOST, localPort: 16443, remote: '127.0.0.1:6443' });
  assert.equal(tunnelRoute(inventory, 'kubernetes', 'lab'), null);
  assert.equal(
    refused({ kubernetes: [{ ...kube, tunnel: TUNNEL }] }),
    'kubernetes "lab": tunnel: unknown key "jumps"',
  );
});

test('no copy, text or listing of the inventory or of its targets holds the route', () => {
  const inventory = validateInventory({ vault: [{ ...VAULT, tunnel: TUNNEL }] });
  const [target] = inventory.vault;
  const texts = [
    JSON.stringify(inventory),
    JSON.stringify(structuredClone(inventory)),
    JSON.stringify({ ...inventory }),
    util.inspect(inventory, { showHidden: true, depth: Infinity }),
    util.inspect(target, { showHidden: true, depth: Infinity }),
    JSON.stringify(Reflect.ownKeys(inventory).map(String)),
    JSON.stringify(Reflect.ownKeys(target).map(String)),
    JSON.stringify(toolDefinitions(inventory)),
    routed.agentSection(target),
    JSON.stringify(routed.record({ target }, { reviewed: false })),
    routed.hint(target),
    routed.openingMessage(target),
  ];
  for (const text of texts) {
    for (const part of [...ROUTE_PARTS, 'tunnel']) assert.ok(!text.includes(part), `${part} in ${text}`);
  }
  assert.deepEqual(Reflect.ownKeys(inventory), [...KINDS.map((kind) => kind.key), 'reviewers']);
  assert.deepEqual(Object.getOwnPropertyNames(target), Object.keys(target));
});

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

test('a session of a target with a route: session.json, AGENT.md, list_targets and the session files hold none of it', async () => {
  // The fake ssh in stream mode joins the stream of the trial to the service of the test.
  const world = await makeWorld({
    extraEnv: { VAULT_TEST_TOKEN: 'tok-test', [['KSPROXY', 'FAKE_SSH_STREAM_PORT'].join('_')]: String(service.port) },
  });
  const sshLog = path.join(world.base, 'ssh.log');
  world.env[['KSPROXY', 'FAKE_SSH_LOG'].join('_')] = sshLog;
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.vault = [{ ...VAULT, tunnel: TUNNEL }];
  fs.writeFileSync(file, JSON.stringify(raw));
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  try {
    // The trial went through one jump to the address of tunnelTo.
    assert.deepEqual(service.lines, ['PING']);
    const streams = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((argv) => argv[1] === '/dev/null');
    assert.equal(streams.length, 1);
    assert.match(streams[0].at(-1), / -W vault\.example\.com:8200 opsuser@192\.0\.2\.10$/);
    const session = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
    assert.deepEqual(session.targets.map((t) => [t.kind, t.name]), [['vault', 'v1']]);
    const agentMd = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
    assert.equal(agentMd, agentMdText(session));
    const listed = (await callTool('list_targets', {}, world.env)).text;
    assert.match(listed, /"v1"/);
    const sessionTexts = filesUnder(world.sessionDir).map((name) => fs.readFileSync(name, 'utf8'));
    for (const text of [...sessionTexts, listed, JSON.stringify(session)]) {
      for (const part of [...ROUTE_PARTS, 'tunnel']) assert.ok(!text.includes(part), `${part} in ${text}`);
    }
    // The lines of start and the audit log may name the first server later, never the jumps.
    for (const text of [fs.readFileSync(world.auditLog, 'utf8'), run.proc.stdout.text, run.proc.stderr.text]) {
      for (const part of JUMP_PARTS) assert.ok(!text.includes(part), `${part} in ${text}`);
    }
  } finally {
    await stopWith(run);
  }
});
