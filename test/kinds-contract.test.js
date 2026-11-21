import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleInventory } from '../src/inventory.js';
import {
  KINDS, kindByFlag, kindByKey, kindByTool, secretFilesOf,
} from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';

const OPTIONAL = [
  'wordsNotForReview', 'notForReview', 'reviewServerCheck', 'scrubDirs', 'scrubText', 'forCheck', 'checkExtra', 'secretFiles',
  'reapStale', 'prepare', 'close', 'onCloseTimeout', 'sessionFiles', 'secrets', 'checkInput',
];

test('every built-in kind meets the contract', () => {
  for (const kind of KINDS) checkKind(kind, KINDS);
});

test('the built-in kinds between them use and leave out each optional function', () => {
  assert.ok(OPTIONAL.every((name) => KINDS.some((kind) => kind[name] !== undefined)));
  assert.ok(OPTIONAL.every((name) => KINDS.some((kind) => kind[name] === undefined)));
});

test('the contract check refuses each kind of mistake', () => {
  const [ssh, kubernetes] = KINDS;
  const bad = (change) => {
    const kind = { ...ssh, ...change };
    checkKind(kind, [kind, kubernetes]);
  };
  assert.doesNotThrow(() => checkKind(ssh, KINDS));
  assert.throws(() => bad({ key: 'Ssh' }), /key/);
  assert.throws(() => bad({ key: '1ssh' }), /key/);
  assert.throws(() => bad({ flag: 'a b' }), /flag/);
  assert.throws(() => bad({ label: 'ssh!' }), /label/);
  assert.throws(() => bad({ label: 'sshss' }), /at most 4 characters/);
  for (const flag of ['all', 'verbose', 'help', 'version']) assert.throws(() => bad({ flag }), /flag is an option of its own/);
  assert.throws(() => bad({ key: 'kube' }), /also a key, a label or a tool name of kubernetes/);
  assert.throws(() => bad({ label: 'kube' }), /label must be unique/);
  assert.throws(() => bad({ tool: { ...ssh.tool, name: 'kubectl' } }), /also a key, a label or a tool name of kubernetes/);
  const loc = { ...ssh, key: 'loc' };
  assert.throws(() => checkKind(loc, [loc, KINDS[2]]), /also a key, a label or a tool name of local/);
  assert.throws(() => checkKind(ssh, [ssh, { ...ssh }]), /must be unique/);
  assert.throws(() => bad({ closeMs: 0 }), /closeMs/);
  assert.throws(() => bad({ closeLimit: undefined }), /closeLimit/);
  assert.throws(() => bad({ close: undefined }), /closeLimit/);
  assert.throws(() => bad({ decide: 'x' }), /decide/);
  assert.throws(() => bad({ reapStale: 'x' }), /reapStale/);
  assert.throws(() => bad({ toolBullet: 'nothing' }), /names the tool/);
  assert.throws(() => bad({ tool: { ...ssh.tool, detailShape: 'string' } }), /tool.detailShape is object or left out/);
  assert.throws(() => bad({ tool: { ...ssh.tool, auditedDetail: () => null } }), /auditedDetail is only for an object call/);
  assert.throws(() => bad({ tool: { ...ssh.tool, detailText: () => '' } }), /detailText is only for an object call/);
});

test('the contract check holds a kind whose call is an object to its audit functions', () => {
  const http = kindByKey('http');
  const others = KINDS.filter((kind) => kind !== http);
  const bad = (change) => {
    const kind = { ...http, tool: { ...http.tool, ...change } };
    checkKind(kind, [kind, ...others]);
  };
  assert.doesNotThrow(() => checkKind(http, KINDS));
  assert.throws(() => bad({ detailIsArray: true }), /an object call is not an array/);
  assert.throws(() => bad({ detailKey: 'path' }), /detailKey of an object call is not an argument/);
  assert.throws(() => bad({ auditedDetail: undefined }), /tool.auditedDetail/);
  assert.throws(() => bad({ detailText: undefined }), /tool.detailText/);
  const bent = { ...http, checkInput: 'x' };
  assert.throws(() => checkKind(bent, [bent, ...others]), /http: checkInput/);
});

test('the contract check holds a brokered kind to perform, and every other kind to command and state', async (t) => {
  const { default: vault } = await import('./fixtures/kind-brokered.js');
  const [ssh, kubernetes] = KINDS;
  const list = (kind) => [kind, ...KINDS.filter((other) => other !== vault)];
  KINDS.push(vault);
  t.after(() => KINDS.pop());
  assert.doesNotThrow(() => checkKind(vault, list(vault)));
  const brokered = (change) => {
    const kind = { ...vault, ...change };
    checkKind(kind, list(kind));
  };
  assert.throws(() => brokered({ perform: undefined }), /vault: perform/);
  assert.throws(() => brokered({ command: ssh.command }), /a brokered kind has no command/);
  assert.throws(() => brokered({ state: ssh.state }), /a brokered kind has no state/);
  assert.throws(() => brokered({ probe: 'x' }), /vault: probe/);
  assert.throws(() => brokered({ secrets: 'x' }), /vault: secrets/);
  assert.throws(() => brokered({ brokered: 'yes' }), /brokered is true or left out/);
  assert.doesNotThrow(() => brokered({ probe: undefined, secrets: undefined }));
  const plain = (change) => {
    const kind = { ...ssh, ...change };
    checkKind(kind, [kind, kubernetes]);
  };
  assert.throws(() => plain({ command: undefined }), /ssh: command/);
  assert.throws(() => plain({ state: undefined }), /ssh: state/);
  assert.throws(() => plain({ perform: async () => ({}) }), /perform is only for a brokered kind/);
  assert.throws(() => plain({ probe: async () => 'up' }), /probe is only for a brokered kind/);
  assert.throws(() => plain({ brokered: false }), /brokered is true or left out/);
  assert.ok(KINDS.slice(0, 3).every((kind) => kind.brokered === undefined && kind.secrets === undefined));
});

test('the opening line, the DOWN and UP texts and the session fields are today\'s, in today\'s order', () => {
  const [ssh, kubernetes, local] = KINDS;
  assert.equal(ssh.openingMessage({ host: 'h' }), 'h');
  assert.equal(ssh.openingMessage({ host: 'h', jumps: ['ssh j'] }), 'h, then 1 jump');
  assert.equal(ssh.openingMessage({ host: 'h', jumps: ['ssh j', 'ssh k'] }), 'h, then 2 jumps');
  assert.equal(kubernetes.openingMessage({ proxyPort: 8001 }), 'port 8001');
  assert.equal(local.openingMessage({ cwd: '/f' }), '/f');
  assert.equal(ssh.downMessage({ name: 'web1' }, 'down'), 'connection lost');
  assert.equal(local.downMessage({ name: 'infra' }, 'down'), 'folder is gone');
  assert.equal(kubernetes.downMessage({ name: 'lab' }, 'auth'), 'token rejected by the cluster');
  assert.equal(kubernetes.downMessage({ name: 'lab' }, 'fail'), 'cluster did not answer, see kube-lab.log');
  assert.equal(kubernetes.downMessage({ name: 'lab' }, 'down'), 'proxy is not answering');
  assert.deepEqual(KINDS.map((kind) => kind.backMessage), ['connection is back', 'connection is back', 'folder is back', 'the call service is back', 'the call service is back', 'the call service is back', 'the call service is back', 'the call service is back', 'the call service is back', 'the call service is back', 'the call service is back', 'the call service is back']);

  const common = { name: 'n', description: 'd', allow: ['x'] };
  const sshTarget = { ...common, host: 'h', jumps: ['ssh j'] };
  assert.deepEqual(Object.keys(ssh.record({ target: sshTarget, socket: '/s' }, { reviewed: true })), [
    'kind', 'name', 'description', 'allow', 'host', 'jumps', 'socket', 'state', 'review',
  ]);
  assert.deepEqual(Object.keys(ssh.record({ target: { ...common, host: 'h' }, socket: '/s' }, { reviewed: false })), [
    'kind', 'name', 'description', 'allow', 'host', 'socket', 'state',
  ]);
  const cluster = { ...common, proxyPort: 8001, manifestRoots: [] };
  assert.deepEqual(Object.keys(kubernetes.record({ target: cluster, handle: { tunnel: null, state: 'auth' } }, { reviewed: true })), [
    'kind', 'name', 'description', 'allow', 'proxyPort', 'manifestRoots', 'tunnel', 'state', 'review',
  ]);
  const folder = {
    ...common, cwd: '/tmp', protect: ['a'], review: { programs: ['ls'] },
  };
  const recorded = local.record({ target: folder }, {
    env: { PATH: '/usr/bin' }, selected: [folder], secretFiles: ['/k'], reviewed: true,
  });
  assert.deepEqual(Object.keys(recorded), [
    'kind', 'name', 'description', 'allow', 'cwd', 'path', 'protected', 'state', 'review', 'protect', 'programs',
  ]);
  assert.equal(recorded.protected[0], '/k');
  assert.deepEqual(recorded.programs, ['ls']);
});

test('the kinds that write session files name ssh_config and kubeconfig, also with nothing open', () => {
  const files = KINDS.filter((kind) => kind.sessionFiles !== undefined).flatMap((kind) => kind.sessionFiles([], {}));
  assert.deepEqual(files.map((file) => file.name), ['ssh_config', 'kubeconfig']);
  assert.ok(files.every((file) => typeof file.text === 'string'));
});

test('command gives a program, its arguments and the run options', () => {
  const session = { targets: [{ kind: 'local', name: 'infra', cwd: '/tmp/infra' }] };
  const decisions = {
    ssh: { allowed: true, rule: 'df -h', command: 'df -h' },
    kubernetes: { allowed: true, rule: 'get ...' },
    local: { allowed: true, rule: 'ls', argv: ['ls', '-l'] },
  };
  const targets = {
    ssh: { kind: 'ssh', name: 'web1', host: 'web1.example.com' },
    kubernetes: { kind: 'kubernetes', name: 'lab', proxyPort: 8001 },
    local: { kind: 'local', name: 'infra', cwd: '/tmp/infra', path: '/usr/bin' },
  };
  for (const kind of KINDS.filter((k) => k.brokered !== true)) {
    const spec = kind.command(targets[kind.key], decisions[kind.key], {
      dir: '/tmp/session', env: { PATH: '/usr/bin' }, session, input: ['get', 'pods'],
    });
    assert.equal(typeof spec.program, 'string', kind.key);
    assert.ok(Array.isArray(spec.args), kind.key);
    assert.ok(spec.args.every((a) => typeof a === 'string'), kind.key);
    assert.equal(typeof spec.options.env, 'object', kind.key);
  }
});

test('secretFilesOf collects the credential files of every kind that names them, in list order', () => {
  const inventory = {
    ssh: [{ name: 'web1' }],
    kubernetes: [{ name: 'lab', kubeconfig: '/k/lab.yaml' }, { name: 'prod', kubeconfig: '/k/prod.yaml' }],
    local: [{ name: 'infra' }],
    kafka: [{ name: 'k', clientConfig: null }],
  };
  assert.deepEqual(secretFilesOf(inventory), ['/k/lab.yaml', '/k/prod.yaml']);
  assert.deepEqual(secretFilesOf({ ssh: [], kubernetes: [], local: [], kafka: [] }), []);
});

test('the list holds the kinds in their fixed order', () => {
  assert.ok(Array.isArray(KINDS));
  assert.deepEqual(KINDS.map((kind) => kind.key), ['ssh', 'kubernetes', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb', 'kafka']);
});

test('the sample inventory holds the sample of every kind, in list order', () => {
  const sample = sampleInventory();
  assert.deepEqual(Object.keys(sample), KINDS.map((kind) => kind.key));
  for (const kind of KINDS) assert.equal(sample[kind.key], kind.sample);
});

test('the lookups return the kind for each of its names and undefined for an unknown name', () => {
  for (const kind of KINDS) {
    assert.equal(kindByKey(kind.key), kind);
    assert.equal(kindByFlag(kind.flag), kind);
    assert.equal(kindByTool(kind.tool.name), kind);
  }
  assert.equal(kindByKey('nope'), undefined);
  assert.equal(kindByFlag('nope'), undefined);
  assert.equal(kindByTool('nope'), undefined);
});
