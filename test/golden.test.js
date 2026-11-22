import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reviewRoute, reviewWordsProblem, toolDefinitions,
} from '../src/tools.js';
import sshKind from '../src/kinds/ssh/index.js';
import kubernetesKind from '../src/kinds/kubernetes/index.js';
import localKind from '../src/kinds/local/index.js';
import { handleMessage } from '../src/mcp.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { agentMdText } from '../src/agent-md.js';
import { formatLogLine } from '../src/audit.js';
import { main } from '../src/cli.js';
import { buildRequest } from '../src/review.js';
import { writeSession } from '../src/session.js';
import { fakeProcess, fakeSsh, freePorts } from './start-helpers.js';
import { tempDir } from './temp.js';

const TOOLS = toolDefinitions();
const decideSsh = sshKind.decide;
const decideKube = kubernetesKind.decide;
const decideLocal = localKind.decide;

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
const WRITE = process.env.UPDATE_GOLDEN === '1';

function golden(name, text) {
  const file = path.join(GOLDEN, name);
  if (WRITE) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  if (text === expected) return;
  const a = text.split('\n');
  const b = expected.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  const line = at === -1 ? Math.min(a.length, b.length) : at;
  assert.fail(`${name} differs from the recorded output at line ${line + 1}:\nnow:      ${a[line]}\nrecorded: ${b[line]}`);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

let base;
let work;
let env;

function tidy(text) {
  return text.split(work).join('<folder>').split(base).join('<tmp>');
}

function tidyJson(value) {
  return tidy(json(value));
}

function shown(input) {
  if (typeof input === 'string' && input.length > 100) return `<string of ${input.length} characters starting ${input.slice(0, 8)}>`;
  return input;
}

before(() => {
  base = fs.realpathSync(tempDir('ks-golden-', os.tmpdir()));
  work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(work, 'vault'));
  fs.mkdirSync(path.join(work, 'venv', 'bin'), { recursive: true });
  for (const [name, text] of [
    ['a.txt', 'a\n'], ['out', 'o\n'], ['credentials', 'c\n'], ['.env', 'x=1\n'], ['.env.example', 'x=\n'],
    ['secrets.pem', 'p\n'], ['private.txt', 'p\n'], [path.join('sub', 'b.txt'), 'b\n'], [path.join('sub', '.env.local'), 'x\n'],
  ]) fs.writeFileSync(path.join(work, name), text);
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside\n');
  fs.writeFileSync(path.join(base, 'outside-prog'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(base, 'kube.yaml'), 'apiVersion: v1\n');
  fs.mkdirSync(path.join(base, 'outdir'));
  fs.mkdirSync(path.join(base, 'st', 'session'), { recursive: true });
  fs.writeFileSync(path.join(base, 'st', 'session', 'session.json'), '{}\n');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(work, 'link'));
  fs.symlinkSync(path.join(base, 'outdir'), path.join(work, 'dirlink'));
  fs.symlinkSync(path.join(base, 'nothing-here'), path.join(work, 'dangling'));
  fs.symlinkSync('loop', path.join(work, 'loop'));
  fs.symlinkSync('/proc/self', path.join(work, 'procl'));
  fs.symlinkSync(path.join(base, 'st'), path.join(work, 'stlink'));
  fs.symlinkSync(path.join(base, 'kube.yaml'), path.join(work, 'kubelink'));
  fs.symlinkSync(path.join(base, 'outside-prog'), path.join(work, 'venv', 'bin', 'run'));
  const manifests = path.join(base, 'manifests');
  fs.mkdirSync(path.join(manifests, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(manifests, 'app.yaml'), 'kind: Pod\n');
  fs.writeFileSync(path.join(base, 'other.yaml'), 'kind: Pod\n');
  fs.symlinkSync(path.join(base, 'other.yaml'), path.join(manifests, 'esc.yaml'));
  env = { KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

test('golden: the tool definitions and the tools/list reply', async () => {
  const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  golden('tools.json', json({ tools: TOOLS, reply }));
});

const FULL_INVENTORY = {
  reviewers: {
    fast: { baseUrl: 'https://review.example.com/v1', model: 'm-1' },
    slow: {
      baseUrl: 'http://localhost:8080/v1/', model: 'm-2', keyEnv: 'REVIEW_KEY', timeoutSeconds: 30, maxCalls: 50,
    },
  },
  ssh: [
    {
      name: 'web1',
      host: 'web1.example.com',
      jumps: ['ssh -i .ssh/key user@bastion', 'ssh -p 2222 user2@inner'],
      description: 'behind two jumps',
      allow: ['uptime', 'df -h'],
      review: { reviewer: 'fast', policy: '  read only  ', accept: ['sure', 'likely'] },
    },
    { name: 'any1', host: 'any1.example.com', allow: 'any' },
    { name: 'bare1', host: 'bare1.example.com' },
  ],
  kubernetes: [
    {
      name: 'lab',
      kubeconfig: '/srv/kube/lab.yaml',
      proxyPort: 18001,
      tunnel: { host: 'bastion.example.com', localPort: 16443, remote: '127.0.0.1:6443' },
      manifestRoots: ['/srv/lab/manifests', '/srv/lab/more'],
      description: 'lab cluster',
      allow: ['get ...', 'apply -f *'],
      review: { reviewer: 'slow', policy: 'read only' },
    },
    { name: 'lab2', kubeconfig: '/srv/kube/lab2.yaml', proxyPort: 18002 },
  ],
  local: [
    {
      name: 'infra',
      cwd: '/srv/infra/',
      description: 'terraform repo',
      allow: ['git status', 'ls ...'],
      review: { reviewer: 'fast', policy: 'p', programs: ['git', 'ls'] },
      protect: ['secrets', './a//b/'],
    },
    { name: 'bare', cwd: '/srv/bare' },
  ],
};

test('golden: a valid inventory that uses every field of every kind', () => {
  golden('inventory.json', json({ empty: validateInventory({}), full: validateInventory(FULL_INVENTORY) }));
});

const GOOD = {
  reviewers: { rv: { baseUrl: 'https://review.example.com/v1', model: 'm' } },
  ssh: { name: 'web1', host: 'web1.example.com', allow: ['uptime'] },
  kube: {
    name: 'lab', kubeconfig: '/srv/kube/lab.yaml', proxyPort: 18001, allow: ['get ...'],
  },
  local: { name: 'infra', cwd: '/srv/infra', allow: ['git status'] },
};
const REVIEW = { reviewer: 'rv', policy: 'read only' };

function brokenInventories() {
  const cases = [];
  const add = (label, raw) => cases.push([label, raw]);
  const withRv = (raw) => ({ reviewers: GOOD.reviewers, ...raw });
  const ssh = (label, patch) => add(`ssh ${label}`, withRv({ ssh: [{ ...GOOD.ssh, ...patch }] }));
  const kube = (label, patch) => add(`kubernetes ${label}`, withRv({ kubernetes: [{ ...GOOD.kube, ...patch }] }));
  const local = (label, patch) => add(`local ${label}`, withRv({ local: [{ ...GOOD.local, ...patch }] }));
  const reviewer = (label, patch) => add(`reviewer ${label}`, { reviewers: { rv: { ...GOOD.reviewers.rv, ...patch } } });

  add('top level array', []);
  add('top level null', null);
  add('top level string', 'x');
  add('top level unknown key', { nope: 1 });
  add('top level ssh not an array', { ssh: {} });
  add('top level kubernetes not an array', { kubernetes: 'x' });
  add('top level local not an array', { local: 1 });
  add('top level reviewers an array', { reviewers: [] });

  add('ssh entry a string', { ssh: ['x'] });
  add('ssh entry null', { ssh: [null] });
  add('ssh entry an array', { ssh: [[]] });
  ssh('name missing', { name: undefined });
  ssh('name uppercase', { name: 'Web1' });
  ssh('name too long', { name: 'a'.repeat(32) });
  ssh('name starts with a dash', { name: '-web' });
  ssh('name a number', { name: 5 });
  add('ssh duplicate name', { ssh: [GOOD.ssh, { ...GOOD.ssh, host: 'other.example.com' }] });
  ssh('description a number', { description: 5 });
  ssh('unknown key', { nope: 1 });
  ssh('kubeconfig key', { kubeconfig: '/x' });
  ssh('host missing', { host: undefined });
  ssh('host leading dash', { host: '-oProxyCommand=x' });
  ssh('host with a space', { host: 'a b' });
  ssh('host a number', { host: 5 });
  ssh('host empty', { host: '' });
  ssh('jumps not an array', { jumps: 'ssh a@b' });
  ssh('jumps empty', { jumps: [] });
  ssh('jumps six items', { jumps: Array(6).fill('ssh a@b') });
  ssh('jumps item a number', { jumps: [5] });
  ssh('jumps item blank', { jumps: ['  '] });
  ssh('jumps item with a tilde', { jumps: ['ssh -i ~/.ssh/k a@b'] });
  ssh('jumps item not ssh', { jumps: ['scp a@b'] });
  ssh('jumps item with an unsupported option', { jumps: ['ssh -A a@b'] });
  ssh('jumps item option without a value', { jumps: ['ssh -i'] });
  ssh('jumps item value with a dash', { jumps: ['ssh -i -x a@b'] });
  ssh('jumps item -o without Key=Value', { jumps: ['ssh -o Port a@b'] });
  ssh('jumps item -o unsupported setting', { jumps: ['ssh -o ProxyCommand=x a@b'] });
  ssh('jumps item without a server', { jumps: ['ssh -p 22'] });
  ssh('jumps item with a bad server', { jumps: ['ssh -p 22 a;b'] });
  ssh('jumps item with words after the server', { jumps: ['ssh a@b ls'] });
  ssh('jumps item with an equals word', { jumps: ['ssh -i =x a@b'] });
  ssh('jumps item with a shell character', { jumps: ['ssh a@b;ls'] });
  ssh('jumps with allow any', { jumps: ['ssh a@b'], allow: 'any' });
  ssh('allow a string other than any', { allow: 'all' });
  ssh('allow an object', { allow: {} });
  ssh('allow rule empty', { allow: [''] });
  ssh('allow rule not last dots', { allow: ['ls ... x'] });
  ssh('allow rule a number', { allow: [5] });
  ssh('allow second rule bad', { allow: ['ls', ' '] });
  ssh('review a string', { review: 'yes' });
  ssh('review unknown key', { review: { ...REVIEW, nope: 1 } });
  ssh('review with allow any', { allow: 'any', review: REVIEW });
  ssh('review with programs', { review: { ...REVIEW, programs: ['ls'] } });
  ssh('review reviewer missing', { review: { policy: 'p' } });
  ssh('review reviewer unknown', { review: { reviewer: 'nobody', policy: 'p' } });
  ssh('review reviewer a number', { review: { reviewer: 5, policy: 'p' } });
  ssh('review policy missing', { review: { reviewer: 'rv' } });
  ssh('review policy blank', { review: { reviewer: 'rv', policy: '  ' } });
  ssh('review policy too long', { review: { reviewer: 'rv', policy: 'p'.repeat(1001) } });
  ssh('review accept empty', { review: { ...REVIEW, accept: [] } });
  ssh('review accept unsure', { review: { ...REVIEW, accept: ['unsure'] } });
  ssh('review accept repeated', { review: { ...REVIEW, accept: ['sure', 'sure'] } });
  ssh('review accept a string', { review: { ...REVIEW, accept: 'sure' } });
  add('ssh review without reviewers', { ssh: [{ ...GOOD.ssh, review: REVIEW }] });

  add('kubernetes entry a number', { kubernetes: [5] });
  kube('name uppercase', { name: 'LAB' });
  kube('name empty', { name: '' });
  kube('name too long', { name: 'b'.repeat(40) });
  add('kubernetes duplicate name', { kubernetes: [GOOD.kube, { ...GOOD.kube, proxyPort: 18002 }] });
  kube('description a list', { description: [] });
  kube('unknown key', { nope: 1 });
  kube('jumps key', { jumps: ['ssh a@b'] });
  kube('host key', { host: 'a.example.com' });
  kube('kubeconfig missing', { kubeconfig: undefined });
  kube('kubeconfig empty', { kubeconfig: '' });
  kube('kubeconfig relative', { kubeconfig: 'kube.yaml' });
  kube('kubeconfig a number', { kubeconfig: 5 });
  kube('proxyPort missing', { proxyPort: undefined });
  kube('proxyPort too low', { proxyPort: 80 });
  kube('proxyPort too high', { proxyPort: 70000 });
  kube('proxyPort a fraction', { proxyPort: 18001.5 });
  kube('proxyPort a string', { proxyPort: '18001' });
  add('kubernetes duplicate proxyPort', { kubernetes: [GOOD.kube, { ...GOOD.kube, name: 'lab2' }] });
  kube('tunnel a string', { tunnel: 'x' });
  kube('tunnel unknown key', { tunnel: { host: 'h', localPort: 16443, remote: 'h:1', nope: 1 } });
  kube('tunnel host missing', { tunnel: { localPort: 16443, remote: 'h:1' } });
  kube('tunnel host leading dash', { tunnel: { host: '-h', localPort: 16443, remote: 'h:1' } });
  kube('tunnel localPort missing', { tunnel: { host: 'h', remote: 'h:1' } });
  kube('tunnel localPort too low', { tunnel: { host: 'h', localPort: 22, remote: 'h:1' } });
  kube('tunnel localPort equal to proxyPort', { tunnel: { host: 'h', localPort: 18001, remote: 'h:1' } });
  kube('tunnel remote missing', { tunnel: { host: 'h', localPort: 16443 } });
  kube('tunnel remote without a port', { tunnel: { host: 'h', localPort: 16443, remote: 'host' } });
  kube('tunnel remote port zero', { tunnel: { host: 'h', localPort: 16443, remote: 'h:0' } });
  kube('tunnel remote port too high', { tunnel: { host: 'h', localPort: 16443, remote: 'h:70000' } });
  kube('tunnel remote with a space', { tunnel: { host: 'h', localPort: 16443, remote: 'h x:1' } });
  kube('tunnel remote a number', { tunnel: { host: 'h', localPort: 16443, remote: 6443 } });
  kube('manifestRoots a string', { manifestRoots: '/x' });
  kube('manifestRoots item relative', { manifestRoots: ['/x', 'y'] });
  kube('manifestRoots item empty', { manifestRoots: [''] });
  kube('manifestRoots item a number', { manifestRoots: [5] });
  kube('allow a string other than any', { allow: 'all' });
  kube('allow rule empty', { allow: [' '] });
  kube('allow rule not last dots', { allow: ['get ... x'] });
  kube('review a list', { review: [] });
  kube('review unknown key', { review: { ...REVIEW, nope: 1 } });
  kube('review with allow any', { allow: 'any', review: REVIEW });
  kube('review with programs', { review: { ...REVIEW, programs: ['get'] } });
  kube('review reviewer unknown', { review: { reviewer: 'nobody', policy: 'p' } });
  kube('review policy missing', { review: { reviewer: 'rv' } });
  kube('review accept unsure', { review: { ...REVIEW, accept: ['sure', 'unsure'] } });

  add('local entry null', { local: [null] });
  local('name uppercase', { name: 'Infra' });
  local('name too long', { name: 'c'.repeat(33) });
  local('name with a space', { name: 'in fra' });
  add('local duplicate name', { local: [GOOD.local, GOOD.local] });
  local('description a number', { description: 1 });
  local('unknown key', { nope: 1 });
  local('allowOutsidePaths key', { allowOutsidePaths: true });
  local('host key', { host: 'a.example.com' });
  local('jumps key', { jumps: ['ssh a@b'] });
  local('cwd missing', { cwd: undefined });
  local('cwd empty', { cwd: '' });
  local('cwd relative', { cwd: 'infra' });
  local('cwd a number', { cwd: 5 });
  local('allow any', { allow: 'any' });
  local('allow a string', { allow: 'git' });
  local('allow rule empty', { allow: [''] });
  local('allow rule starts with a star', { allow: ['* status'] });
  local('allow rule starts with dots', { allow: ['...'] });
  local('allow rule not last dots', { allow: ['git ... x'] });
  local('review without programs', { review: REVIEW });
  local('review programs a string', { review: { ...REVIEW, programs: 'git' } });
  local('review programs empty', { review: { ...REVIEW, programs: [] } });
  local('review programs fifty one', { review: { ...REVIEW, programs: Array.from({ length: 51 }, (_, i) => `p${i}`) } });
  local('review programs a bad name', { review: { ...REVIEW, programs: ['git status'] } });
  local('review programs a number', { review: { ...REVIEW, programs: [5] } });
  local('review programs repeated', { review: { ...REVIEW, programs: ['git', 'git'] } });
  local('review programs dots', { review: { ...REVIEW, programs: ['...'] } });
  local('review programs unknown key', { review: { ...REVIEW, programs: ['git'], nope: 1 } });
  local('review with a missing reviewer', { review: { policy: 'p', programs: ['git'] } });
  local('protect a string', { protect: 'x' });
  local('protect empty', { protect: [] });
  local('protect fifty one', { protect: Array.from({ length: 51 }, (_, i) => `p${i}`) });
  local('protect item a number', { protect: [5] });
  local('protect item empty', { protect: [''] });
  local('protect item too long', { protect: ['p'.repeat(513)] });
  local('protect item with a control character', { protect: ['a\nb'] });
  local('protect item absolute', { protect: ['/etc'] });
  local('protect item with a tilde', { protect: ['~/x'] });
  local('protect item with dot dot', { protect: ['a/../b'] });
  local('protect item the folder itself', { protect: ['./'] });
  local('protect item a dot', { protect: ['.'] });
  local('protect item repeated', { protect: ['a/b', './a//b'] });

  add('reviewer name uppercase', { reviewers: { Rv: GOOD.reviewers.rv } });
  add('reviewer entry a string', { reviewers: { rv: 'x' } });
  reviewer('unknown key', { nope: 1 });
  reviewer('baseUrl missing', { baseUrl: undefined });
  reviewer('baseUrl not a url', { baseUrl: 'not a url' });
  reviewer('baseUrl a number', { baseUrl: 5 });
  reviewer('baseUrl http to a remote host', { baseUrl: 'http://review.example.com/v1' });
  reviewer('baseUrl ftp', { baseUrl: 'ftp://localhost/v1' });
  reviewer('baseUrl with a user name', { baseUrl: 'https://u:p@review.example.com/v1' });
  reviewer('baseUrl with a query', { baseUrl: 'https://review.example.com/v1?k=1' });
  reviewer('baseUrl with a fragment', { baseUrl: 'https://review.example.com/v1#x' });
  reviewer('model missing', { model: undefined });
  reviewer('model with a space', { model: 'a b' });
  reviewer('model too long', { model: 'm'.repeat(201) });
  reviewer('model a number', { model: 5 });
  reviewer('keyEnv lowercase', { keyEnv: 'key' });
  reviewer('keyEnv starts with KSPROXY_', { keyEnv: 'KSPROXY_KEY' });
  reviewer('keyEnv a number', { keyEnv: 5 });
  reviewer('keyEnv PATH', { keyEnv: 'PATH' });
  reviewer('keyEnv with a session prefix', { keyEnv: 'SSH_KEY' });
  reviewer('keyEnv with another session prefix', { keyEnv: 'LC_KEY' });
  reviewer('timeoutSeconds zero', { timeoutSeconds: 0 });
  reviewer('timeoutSeconds too high', { timeoutSeconds: 61 });
  reviewer('timeoutSeconds a fraction', { timeoutSeconds: 1.5 });
  reviewer('maxCalls zero', { maxCalls: 0 });
  reviewer('maxCalls too high', { maxCalls: 100001 });
  reviewer('maxCalls a string', { maxCalls: '5' });
  return cases;
}

test('golden: the message for each broken inventory', () => {
  const rows = brokenInventories().map(([label, raw]) => {
    try {
      validateInventory(raw);
    } catch (err) {
      assert.ok(err instanceof InventoryError, `${label}: ${err.message}`);
      return { label, message: err.message };
    }
    return assert.fail(`${label}: was accepted`);
  });
  assert.ok(rows.length >= 40);
  golden('inventory-errors.json', json(rows));
});

const CAN = { description: '', state: 'up' };

test('golden: the agent notes for every variant of every kind', () => {
  const session = {
    targets: [
      {
        ...CAN, kind: 'ssh', name: 'web1', description: 'web box', allow: ['uptime', 'df -h'],
      },
      {
        ...CAN, kind: 'ssh', name: 'any1', allow: 'any',
      },
      {
        ...CAN, kind: 'ssh', name: 'jmp', description: 'behind a bastion', allow: ['uptime'], jumps: ['ssh -i k u@b'],
      },
      {
        ...CAN, kind: 'ssh', name: 'rev', description: 'reviewed', allow: ['uptime'], review: true,
      },
      {
        ...CAN, kind: 'ssh', name: 'none', allow: [], jumps: ['ssh a@b'], review: true,
      },
      {
        ...CAN, kind: 'kubernetes', name: 'lab', description: 'lab cluster', allow: ['get ...'], manifestRoots: ['/srv/m', '/srv/n'],
      },
      {
        ...CAN, kind: 'kubernetes', name: 'noroots', allow: ['get ...'], manifestRoots: [],
      },
      {
        ...CAN, kind: 'kubernetes', name: 'downk', allow: ['get ...'], manifestRoots: [], state: 'down', review: true,
      },
      {
        ...CAN, kind: 'kubernetes', name: 'authk', description: 'no access', allow: [], manifestRoots: ['/srv/m'], state: 'auth',
      },
      {
        ...CAN, kind: 'local', name: 'infra', description: 'terraform repo', allow: ['git status', 'ls ...'],
      },
      {
        ...CAN, kind: 'local', name: 'downl', allow: ['ls'], state: 'down', review: true, programs: ['ls'],
      },
      {
        ...CAN, kind: 'local', name: 'revl', description: 'reviewed', allow: ['ls'], review: true, programs: ['git', 'ls'],
      },
    ],
  };
  const reordered = { targets: [session.targets[9], session.targets[0], session.targets[5], session.targets[10]] };
  golden('agent-md.txt', `${agentMdText(session)}=====\n${agentMdText(reordered)}`);
});

const MANIFESTS = () => path.join(base, 'manifests');

function sshTarget(extra = {}) {
  return {
    kind: 'ssh',
    name: 'web1',
    host: 'web1.example.com',
    description: '',
    allow: ['uptime', 'systemctl status *', 'journalctl -u app ...', 'df -h', 'echo ...'],
    socket: '/s/ssh-web1',
    state: 'up',
    ...extra,
  };
}

function kubeTarget(extra = {}) {
  return {
    kind: 'kubernetes',
    name: 'lab',
    proxyPort: 18001,
    description: '',
    state: 'up',
    allow: ['get ...', 'describe ...', 'logs ...', 'rollout status ...', 'apply -f *', 'auth can-i ...'],
    manifestRoots: [MANIFESTS()],
    ...extra,
  };
}

const LOCAL_ALLOW = [
  'cat *', 'ls ...', 'ls -l ...', 'git log ...', 'git log --oneline -n * ...', 'git status', './run.sh', 'tool ...',
  'venv/bin/run ...', 'curl -d@payload.json *', 'cat /etc/hosts',
];

function localTarget(extra = {}) {
  return {
    kind: 'local',
    name: 'infra',
    description: '',
    state: 'up',
    cwd: work,
    allow: LOCAL_ALLOW,
    protected: [path.join(base, 'kube.yaml')],
    protect: ['vault', 'private.txt'],
    ...extra,
  };
}

function decisionCases() {
  const rows = [];
  const add = (kind, label, target, input, decide) => {
    const decision = decide(target, input);
    rows.push({
      kind,
      label,
      input: shown(input),
      reviewOnTarget: target.review === true,
      decision,
      routeOn: reviewRoute(kind, decision, true),
      routeOff: reviewRoute(kind, decision, false),
    });
  };
  const JUMP = 'ssh -i .ssh/key user@bastion';
  const ssh = (label, input, extra) => add('ssh', label, sshTarget(extra), input, (t, i) => decideSsh(t, i));
  const kube = (label, input, extra) => add('kubernetes', label, kubeTarget(extra), input, (t, i) => decideKube(t, i));
  const local = (label, input, extra) => add('local', label, localTarget(extra), input, (t, i) => decideLocal(t, i, env));
  const manifest = (name) => path.join(MANIFESTS(), name);

  ssh('literal rule', 'uptime');
  ssh('star rule', 'systemctl status nginx');
  ssh('star rule with a flag', 'systemctl status -x');
  ssh('star rule without an argument', 'systemctl status');
  ssh('dots rule', 'journalctl -u app -n 20 --no-pager');
  ssh('dots rule with no rest', 'journalctl -u app');
  ssh('literal rule with a flag', 'df -h');
  ssh('not on the allowlist', 'rm -rf /');
  ssh('not on the allowlist with spaces and tabs', 'df\t -h');
  ssh('empty allowlist', 'uptime', { allow: [] });
  ssh('plain: not a string', 42);
  ssh('plain: too long', `uptime ${'a'.repeat(5000)}`);
  ssh('plain: empty', '');
  ssh('plain: blank', '   ');
  ssh('plain: semicolon', 'ls;');
  ssh('plain: dollar', 'ls $HOME');
  ssh('plain: quote', 'ls "x"');
  ssh('plain: pipe', 'ls | grep x');
  ssh('plain: non-ascii', 'ls é');
  ssh('plain: control character', 'ls a\u0001');
  ssh('plain: starts with a dash', '-rf');
  ssh('any: a pipeline', 'ls | grep x | wc -l', { allow: 'any' });
  ssh('any: quotes', 'echo "a b"', { allow: 'any' });
  ssh('any: not a string', 42, { allow: 'any' });
  ssh('any: too long', 'a'.repeat(5000), { allow: 'any' });
  ssh('any: empty', '', { allow: 'any' });
  ssh('any: blank', '   ', { allow: 'any' });
  ssh('any: NUL', 'a\u0000b', { allow: 'any' });
  ssh('any: newline', 'a\nb', { allow: 'any' });
  ssh('any: delete character', 'a\u007fb', { allow: 'any' });
  ssh('any: starts with a dash', ' -rf', { allow: 'any' });
  ssh('any: tab is fine', 'a\tb', { allow: 'any' });
  ssh('jumps: literal rule', 'uptime', { jumps: [JUMP] });
  ssh('jumps: two jumps', 'uptime', { jumps: ['ssh -i a u@b', 'ssh -p 2222 -o Port=22 v@c'] });
  ssh('jumps: not on the allowlist', 'rm x', { jumps: [JUMP] });
  ssh('jumps: starts with equals', 'echo =x', { jumps: [JUMP] });
  ssh('jumps: double equals', 'echo a==b', { jumps: [JUMP] });
  ssh('jumps: colon equals', 'echo a:=b', { jumps: [JUMP] });
  ssh('jumps: an equals word is checked before the allowlist', 'rm =x', { jumps: [JUMP] });
  ssh('no jumps: an equals word is fine', 'echo =x');
  ssh('jumps: allow any', 'ls', { jumps: [JUMP], allow: 'any' });
  ssh('jumps: empty list', 'uptime', { jumps: [] });
  ssh('jumps: null', 'uptime', { jumps: null });
  ssh('jumps: not usable option', 'uptime', { jumps: ['ssh -A u@h'] });
  ssh('jumps: six', 'uptime', { jumps: Array(6).fill('ssh a@b') });
  ssh('jumps: not a list', 'uptime', { jumps: 'ssh a@b' });
  ssh('jumps: not usable, allow any, empty command', '', { jumps: [], allow: 'any' });
  ssh('review: unlisted command goes to the reviewer', 'df', { review: true });
  ssh('review: unlisted command with jumps', 'df', { review: true, jumps: [JUMP] });
  ssh('review: listed command', 'uptime', { review: true });
  ssh('review: sixty four words', `echo ${'a '.repeat(63).trim()}`, { review: true, allow: ['uptime'] });
  ssh('review: sixty five words', `echo ${'a '.repeat(64).trim()}`, { review: true, allow: ['uptime'] });
  ssh('review: a word of two hundred characters', `echo ${'a'.repeat(200)}`, { review: true, allow: ['uptime'] });
  ssh('review: a word of two hundred and one characters', `echo ${'a'.repeat(201)}`, { review: true, allow: ['uptime'] });
  ssh('review: a word that starts with equals', 'df =x', { review: true });
  ssh('review: a word with double equals', 'df a==b', { review: true });
  ssh('review: a word with colon equals', 'df a:=b', { review: true });
  ssh('review: first word sets a variable', 'LD_PRELOAD=x uptime', { review: true });
  ssh('review: a later word with one equals', 'df a=b', { review: true });
  ssh('review: empty allowlist', 'df -h', { review: true, allow: [] });
  ssh('review: tokenizer refusal is never reviewed', 'df;', { review: true });
  ssh('review: review false is not review', 'df', { review: false });

  kube('get with a namespace', ['get', 'pods', '-n', 'web']);
  kube('describe', ['describe', 'pod', 'x']);
  kube('logs', ['logs', 'pod/x', '--tail', '20']);
  kube('rollout status', ['rollout', 'status', 'deploy/x']);
  kube('rollout restart is not listed', ['rollout', 'restart', 'deploy/x']);
  kube('output json', ['get', 'pods', '-o', 'json']);
  kube('output jsonpath', ['get', 'pods', '-o', 'jsonpath={.items[0].metadata.name}']);
  kube('output with an equals sign', ['get', 'pods', '--output=wide']);
  kube('flag with underscores', ['get', 'pods', '--all_namespaces']);
  kube('auth can-i', ['auth', 'can-i', 'get', 'pods']);
  kube('apply a manifest', ['apply', '-f', manifest('app.yaml')]);
  kube('apply with the long flag', ['apply', `--filename=${manifest('app.yaml')}`]);
  kube('logs -f is not a manifest', ['logs', 'pod/x', '-f']);
  kube('delete is not listed', ['delete', 'pod', 'x']);
  kube('empty allowlist', ['get', 'pods'], { allow: [] });
  kube('allow any', ['delete', 'pod', 'x'], { allow: 'any' });
  kube('allow any, still refused when hard', ['exec', 'pod', 'x'], { allow: 'any' });
  kube('args not a list', 'get pods');
  kube('args empty', []);
  kube('arg empty', ['get', '']);
  kube('arg not a string', ['get', 5]);
  kube('arg with a control character', ['get', 'pods\u0001']);
  kube('arg too long', ['get', 'a'.repeat(4097)]);
  kube('verb must come first', ['-n', 'web', 'get', 'pods']);
  kube('unknown verb', ['exec', 'pod', 'x']);
  kube('unknown verb, long name', ['x'.repeat(40)]);
  kube('create token', ['create', 'token', 'sa']);
  kube('cluster-info dump', ['cluster-info', 'dump']);
  kube('auth other', ['auth', 'reconcile']);
  kube('auth without a subcommand', ['auth']);
  kube('apply edit-last-applied', ['apply', 'edit-last-applied', 'x']);
  kube('secret resource', ['get', 'secrets']);
  kube('secret resource by slash', ['get', 'secret/x']);
  kube('secret in a list', ['get', 'pods,secrets']);
  kube('secret in a flag value', ['get', 'pods', '--field-selector=secret']);
  kube('bare double dash', ['get', 'pods', '--']);
  kube('combined short flags', ['get', 'pods', '-ojson']);
  kube('short flag with equals is not combined', ['get', 'pods', '-n=web']);
  kube('unknown flag', ['get', 'pods', '--bogus']);
  kube('unknown flag, long name', ['get', 'pods', `--${'b'.repeat(40)}`]);
  kube('identity flag', ['get', 'pods', '--kubeconfig=/x']);
  kube('output format missing', ['get', 'pods', '-o']);
  kube('output format not allowed', ['get', 'pods', '-o', 'go-template=x']);
  kube('manifest flag without a path', ['apply', '-f']);
  kube('manifest from a url', ['apply', '-f', 'https://example.com/x.yaml']);
  kube('manifest from stdin', ['apply', '-f', '-']);
  kube('manifest without roots', ['apply', '-f', manifest('app.yaml')], { manifestRoots: [] });
  kube('manifest without a roots key', ['apply', '-f', manifest('app.yaml')], { manifestRoots: undefined });
  kube('manifest not found', ['apply', '-f', manifest('missing.yaml')]);
  kube('manifest outside the roots', ['apply', '-f', path.join(base, 'other.yaml')]);
  kube('manifest through a link', ['apply', '-f', manifest('esc.yaml')]);
  kube('manifest a directory', ['apply', '-f', manifest('dir')]);
  kube('manifest patch-file', ['patch', 'deploy/x', '--patch-file', manifest('app.yaml')], { allow: ['patch ...'] });
  kube('review: read verb', ['get', 'pods'], { review: true, allow: [] });
  kube('review: read verb with allowlist', ['top', 'nodes'], { review: true });
  kube('review: write verb', ['delete', 'pod', 'x'], { review: true });
  kube('review: scale', ['scale', 'deploy/x', '--replicas', '3'], { review: true });
  kube('review: a word with a space', ['get', 'pods', '-l', 'a b'], { review: true });
  kube('review: a word with a quote', ['get', 'pods', '-l', 'a"b'], { review: true });
  kube('review: sixty five words', ['get', ...Array(64).fill('p')], { review: true });
  kube('review: a word of two hundred and one characters', ['get', 'a'.repeat(201)], { review: true });
  kube('review: a hard refusal is never reviewed', ['get', 'secrets'], { review: true });
  kube('review: allowed', ['get', 'pods', '-n', 'web'], { review: true });

  local('allowed: cat a file', 'cat a.txt');
  local('allowed: cat in a subfolder', 'cat sub/b.txt');
  local('allowed: cat with ./', 'cat ./a.txt');
  local('allowed: cat a new file', 'cat new.txt');
  local('allowed: cat the folder', 'cat .');
  local('allowed: cat with a trailing slash', 'cat sub/');
  local('allowed: bare ls', 'ls');
  local('allowed: ls a folder', 'ls sub');
  local('allowed: ls -l', 'ls -l sub');
  local('allowed: literal rule', 'git status');
  local('allowed: git log with a range', 'git log --oneline -n 20 main..dev');
  local('allowed: a program path', './run.sh');
  local('allowed: a literal outside path', 'cat /etc/hosts');
  local('allowed: a literal flag with an argument', 'curl -d@payload.json example.org');
  local('allowed: a program that is a link out', 'venv/bin/run a.txt');
  local('allowed: an example env file', 'cat .env.example');
  local('refused: an absolute path', 'cat /etc/passwd');
  local('refused: a flag matched by dots', 'ls --color=auto');
  local('refused: a flag matched by a star', 'cat -n a.txt');
  local('refused: a flag in git log', 'git log -p');
  local('refused: odd shapes', 'tool --include=a:/etc');
  local('refused: dot dot', 'cat ../x');
  local('refused: dot dot inside', 'cat sub/../../x');
  local('refused: a link out', 'cat link');
  local('refused: through a link folder', 'cat dirlink/x');
  local('refused: a dangling link', 'cat dangling');
  local('refused: a looping link', 'cat loop');
  local('refused: a link into /proc', 'cat procl');
  local('refused: a link to the state folder', 'cat stlink/session/session.json');
  local('refused: a link to a kubeconfig', 'cat kubelink');
  local('refused: a protected folder', 'cat vault/x');
  local('refused: a protected file', 'cat private.txt');
  local('refused: an env file', 'cat .env');
  local('refused: a key file', 'cat secrets.pem');
  local('refused: a credentials file', 'cat credentials');
  local('refused: an env file in a subfolder', 'cat sub/.env.local');
  local('refused: an argument over 512 bytes', `cat ${'a'.repeat(600)}`);
  local('refused: a name too long to examine', `cat ${'a'.repeat(300)}`);
  local('refused: not on the allowlist', 'rm a.txt');
  local('refused: too few words', 'cat');
  local('refused: tokenizer, semicolon', 'ls;');
  local('refused: tokenizer, empty', '');
  local('refused: tokenizer, too long', `ls ${'a'.repeat(5000)}`);
  local('refused: tokenizer, not a string', 42);
  local('refused: tokenizer, dash', '-rf');
  local('refused: tokenizer, quote', 'cat "a"');
  local('refused: the plain problem is shown last', 'cat -x link', { allow: ['cat *', 'cat -x *'] });
  local('empty allowlist', 'ls', { allow: [] });
  local('allow any is no list', 'ls', { allow: 'any' });
  local('allow with only unusable rules', 'ls x', { allow: ['* x', '... y'] });
  local('allow with an unusable rule and a usable one', 'ls', { allow: ['* x', 'ls'] });
  local('allow with a rule that is not a string', 'ls', { allow: [5, 'ls'] });
  local('folder: too broad', 'cat a.txt', { cwd: '/' });
  local('folder: a link into /proc', 'cat a.txt', { cwd: path.join(work, 'procl') });
  local('folder: overlaps the state folder', 'cat a.txt', { cwd: path.join(base, 'st', 'session') });
  local('folder: holds a kubeconfig', 'cat a.txt', { protected: [path.join(work, 'sub', 'kube.yaml')] });
  local('folder: protected list entries that are not paths', 'cat a.txt', { protected: [5, '', path.join(base, 'kube.yaml')] });
  local('folder: protected is not a list', 'cat a.txt', { protected: 'x' });
  local('folder: missing but resolvable', 'cat a.txt', { cwd: path.join(base, 'missing') });
  local('review: listed program, plain arguments', 'git branch', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a simple flag', 'git branch -a', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a flag glued to a file name', 'git diff -oout', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a flag glued to a secret name', 'git diff -xcredentials', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a flag glued to a protected name', 'git diff -xvault', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a flag glued to nothing', 'git diff -xnothing', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a plain path argument', 'git diff sub/b.txt', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a path with dot dot', 'git diff ../x', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a secret path', 'git diff .env', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a link out', 'git diff link', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: a program not listed', 'rm a.txt', { review: true, programs: ['git', 'ls', 'cat'] });
  local('review: no programs at all', 'git branch', { review: true });
  local('review: a flag with a value', 'git branch --format=%H', { review: true, programs: ['git'] });
  local('review: an absolute path', 'git diff /etc/hosts', { review: true, programs: ['git'] });
  local('review: the folder is missing', 'git branch', { review: true, programs: ['git'], cwd: path.join(base, 'missing') });
  local('review: a listed command', 'git status', { review: true, programs: ['git'] });
  local('review: a wildcard problem comes first', 'cat link', { review: true, programs: ['cat'] });
  local('review: the tokenizer refusal is not reviewed', 'git branch;', { review: true, programs: ['git'] });
  local('review: sixty five words', `git ${'a '.repeat(64).trim()}`, { review: true, programs: ['git'] });
  local('review: a word over two hundred characters', `git ${'a'.repeat(201)}`, { review: true, programs: ['git'] });
  local('review: review false', 'git branch', { review: false, programs: ['git'] });
  return rows;
}

function wordsMatrix() {
  const argvs = [
    ['df', '-h'], Array(64).fill('a'), Array(65).fill('a'), ['a'.repeat(200)], ['a'.repeat(201)],
    ['a b'], ['a"b'], ['a\u0001'], ['a\u007f'], ['a\u0085'], ['a\tb'],
    ['=x'], ['a==b'], ['a:=b'], ['A=b', 'cmd'], ['cmd', 'A=b'], ['cmd', '=x'],
  ];
  const rows = [];
  for (const kind of ['ssh', 'kubernetes', 'local']) {
    for (const argv of argvs) {
      rows.push({
        kind,
        argv: argv.length > 10 ? `<${argv.length} words starting ${argv[0].slice(0, 6)}>` : argv.map((w) => shown(w)),
        problem: reviewWordsProblem(kind, argv),
      });
    }
  }
  return rows;
}

function routeMatrix() {
  const unmatched = { allowed: false, unmatched: true, argv: ['get', 'pods'] };
  const decisions = {
    allowed: { allowed: true, rule: 'x' },
    'refused, not unmatched': { allowed: false, argv: ['get', 'pods'], reason: 'r', short: 's' },
    'unmatched, no argv': { allowed: false, unmatched: true },
    'unmatched, argv not a list': { allowed: false, unmatched: true, argv: 'get pods' },
    'unmatched with argv': unmatched,
    'unmatched, notReviewed': { ...unmatched, notReviewed: 'because' },
    'unmatched, notReviewed not a string': { ...unmatched, notReviewed: 5 },
    'unmatched, write verb': { allowed: false, unmatched: true, argv: ['delete', 'pod', 'x'] },
    'unmatched, odd first word': { allowed: false, unmatched: true, argv: ['A=b', 'x'] },
  };
  const rows = [];
  for (const [label, decision] of Object.entries(decisions)) {
    for (const kind of ['ssh', 'kubernetes', 'local']) {
      rows.push({
        label, kind, on: reviewRoute(kind, decision, true), off: reviewRoute(kind, decision, false),
      });
    }
  }
  return rows;
}

test('golden: the decision for a matrix of calls, with review on and off', () => {
  const cases = decisionCases();
  assert.ok(cases.length >= 60);
  golden('decisions.json', tidyJson({ cases, words: wordsMatrix(), routes: routeMatrix() }));
});

const TS = new Date(2026, 10, 21, 9, 5, 7).toISOString();

function callBases() {
  return {
    ssh: { tool: 'ssh_exec', kind: 'ssh', command: 'uptime' },
    kube: { tool: 'kubectl', kind: 'kube', args: ['get', 'pods', '-n', 'web'] },
    local: { tool: 'local_exec', kind: 'loc', command: 'git status' },
  };
}

function logEntries() {
  const rows = [];
  const add = (label, entry) => rows.push([label, { ts: TS, ...entry }]);
  for (const [name, b] of Object.entries(callBases())) {
    const call = { event: 'call', target: 'web1', ...b };
    add(`${name} allowed`, {
      ...call, decision: 'allowed', rule: 'uptime', exitCode: 0, durationMs: 120, stdoutBytes: 5, stderrBytes: 0,
    });
    add(`${name} allowed, slow`, {
      ...call, decision: 'allowed', rule: 'r', exitCode: 0, durationMs: 61000, stdoutBytes: 1200, stderrBytes: 3,
    });
    add(`${name} allowed, no timing`, { ...call, decision: 'allowed', exitCode: 0 });
    add(`${name} exit code`, {
      ...call, decision: 'allowed', rule: 'r', exitCode: 3, durationMs: 1500,
    });
    add(`${name} exit code missing`, { ...call, decision: 'allowed', durationMs: 10 });
    add(`${name} timed out`, {
      ...call, decision: 'allowed', rule: 'r', exitCode: null, timedOut: true, durationMs: 60000,
    });
    add(`${name} could not start`, {
      ...call, decision: 'allowed', rule: 'r', exitCode: null, spawnError: 'ENOENT', durationMs: 2,
    });
    add(`${name} reviewed with a reason`, {
      ...call, decision: 'allowed', rule: 'review', exitCode: 0, durationMs: 50, review: { certainty: 'sure', reason: 'only reads' },
    });
    add(`${name} reviewed without a reason`, {
      ...call, decision: 'allowed', rule: 'review', exitCode: 0, durationMs: 50, review: { certainty: 'likely' },
    });
    add(`${name} refused with a short text`, { ...call, decision: 'refused', reason: 'long reason', short: 'not on allowlist' });
    add(`${name} refused with a reason only`, { ...call, decision: 'refused', reason: 'r'.repeat(100) });
    add(`${name} refused with nothing`, { ...call, decision: 'refused' });
    add(`${name} refused with an unprintable text`, { ...call, decision: 'refused', short: 'a\u001bb\u202ec' });
    add(`${name} control characters`, {
      ...call, decision: 'allowed', rule: 'a\u0007b', exitCode: 0, command: 'a\u001b[31mb', args: ['x\u0000y'],
    });
    add(`${name} invalid detail`, { ...call, decision: 'refused', command: 5, args: 5, short: 'invalid arguments' });
    add(`${name} no detail`, { ...call, decision: 'refused', command: undefined, args: undefined, short: 'invalid arguments' });
    add(`${name} long target`, { ...call, target: 'averylongtargetname', decision: 'refused', short: 's' });
  }
  add('kube spelled in full', {
    event: 'call', kind: 'kubernetes', target: 'lab', args: ['get', 'pods'], decision: 'allowed', exitCode: 0,
  });
  add('local spelled in full', {
    event: 'call', kind: 'local', target: 'infra', command: 'ls', decision: 'allowed', exitCode: 0,
  });
  add('kube by tool only', {
    event: 'call', tool: 'kubectl', target: 'lab', args: ['get', 'pods'], decision: 'allowed', exitCode: 0,
  });
  add('local by tool only', {
    event: 'call', tool: 'local_exec', target: 'infra', command: 'ls', decision: 'allowed', exitCode: 0,
  });
  add('ssh by tool only', {
    event: 'call', tool: 'ssh_exec', target: 'web1', command: 'ls', decision: 'allowed', exitCode: 0,
  });
  add('no kind, no tool', {
    event: 'call', target: 'web1', command: 'ls', decision: 'allowed', exitCode: 0,
  });
  add('no event', { target: 'web1', command: 'ls', decision: 'allowed', exitCode: 0 });
  add('no target', { event: 'call', command: 'ls', decision: 'allowed', exitCode: 0 });
  add('no timestamp', { ts: undefined, event: 'call', command: 'ls', decision: 'allowed', exitCode: 0 });
  add('list', { event: 'list' });
  add('unknown event', { event: 'mystery' });
  const events = [
    'target_opening', 'target_up', 'target_skipped', 'target_warn', 'target_review', 'target_down', 'target_recovered',
    'session_start', 'session_closing', 'session_end',
  ];
  for (const event of events) {
    for (const kind of ['ssh', 'kube', 'kubernetes', 'loc', 'local', undefined, 'bogus']) {
      add(`${event} ${kind ?? 'no kind'}`, {
        event, kind, target: 'web1', message: `message for ${event}`,
      });
    }
  }
  add('lifecycle without a message', { event: 'target_up', kind: 'ssh', target: 'web1' });
  add('lifecycle with an unprintable message', {
    event: 'target_down', kind: 'kube', target: 'lab', message: 'a\u001bb',
  });
  return rows;
}

test('golden: the log line for every kind of entry, verbose and not', () => {
  const lines = [];
  for (const [label, entry] of logEntries()) {
    for (const verbose of [false, true]) {
      lines.push(`${label} | ${verbose ? 'verbose' : 'plain'} | ${formatLogLine(entry, { color: false, verbose })}`);
    }
  }
  lines.push(`narrow | ${formatLogLine(logEntries()[0][1], { width: 30 })}`);
  golden('log-lines.txt', `${lines.join('\n')}\n`);
});

async function cli(args, environment) {
  const proc = fakeProcess();
  const code = await main(args, environment, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

function writeInventory(dir, inventory) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify(inventory));
}

test('golden: the usage text, ksproxy check and ksproxy status', async () => {
  const out = [];
  const record = (label, r) => out.push(`### ${label}\ncode: ${r.code}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`);

  record('--help', await cli(['--help'], {}));
  record('help is not a command', await cli(['help'], {}));
  record('start --bogus', await cli(['start', '--bogus'], {}));
  record('start --ssh without a list', await cli(['start', '--ssh'], {}));
  record('start --kube without a list', await cli(['start', '--kube'], {}));
  record('start --local without a list', await cli(['start', '--local'], {}));
  record('log -n 0', await cli(['log', '-n', '0'], {}));

  const kubeDir = path.join(base, 'kubedir');
  fs.mkdirSync(kubeDir);
  fs.writeFileSync(path.join(kubeDir, 'kube2.yaml'), 'apiVersion: v1\n');
  const review = { reviewer: 'r1', policy: 'read-only' };
  const checkEnv = {
    ...process.env,
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
    KSPROXY_STATE_DIR: path.join(base, 'st'),
    KSPROXY_SSH: fakeSsh,
  };
  writeInventory(checkEnv.KSPROXY_CONFIG_DIR, {
    reviewers: { r1: { baseUrl: 'http://127.0.0.1:9/v1/', model: 'm' } },
    ssh: [
      {
        name: 'web1', host: 'web1.example.com', allow: ['uptime', 'df -h'], review,
      },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
      {
        name: 'jmp', host: 'jmp.example.com', jumps: ['ssh -i .ssh/key user@bastion'], allow: ['uptime'],
      },
      { name: 'anyx', host: 'any.example.com', allow: 'any' },
    ],
    kubernetes: [
      {
        name: 'lab', kubeconfig: path.join(base, 'kube.yaml'), proxyPort: 18001, allow: ['get ...'], review,
      },
      {
        name: 'plain', kubeconfig: path.join(kubeDir, 'kube2.yaml'), proxyPort: 18002, allow: ['get ...'],
      },
    ],
    local: [
      {
        name: 'infra', cwd: work, allow: ['cat *', 'ls ...'], review: { ...review, programs: ['ls'] }, protect: ['vault'],
      },
      { name: 'bad', cwd: kubeDir, allow: ['ls'] },
      { name: 'broad', cwd: '/', allow: ['ls'] },
      { name: 'plainl', cwd: work, allow: ['pwd', 'cat *'] },
    ],
  });
  const checks = [
    ['ssh', 'web1', 'uptime'], ['ssh', 'web1', 'df', '-h'], ['ssh', 'web1', 'rm', '-rf', '/'], ['ssh', 'web1', 'free'],
    ['ssh', 'web1', 'LD_PRELOAD=x', 'uptime'], ['ssh', 'web1', 'ls;'], ['ssh', 'web2', 'free'],
    ['ssh', 'jmp', 'uptime'], ['ssh', 'jmp', 'uptime', '=x'], ['ssh', 'jmp', 'free'], ['ssh', 'anyx', 'ls', '-la'],
    ['ssh', 'nope', 'uptime'],
    ['kube', 'lab', 'get', 'pods'], ['kube', 'lab', 'top', 'nodes'], ['kube', 'lab', 'delete', 'pod', 'x'],
    ['kube', 'lab', 'get', 'pods', '-l', 'a"b'], ['kube', 'plain', 'get', 'secrets'], ['kube', 'plain', 'top', 'nodes'],
    ['kube', 'plain', 'get', 'pods', '-n', 'web'], ['kube', 'nope', 'get', 'pods'],
    ['local', 'infra', 'cat', 'a.txt'], ['local', 'infra', 'ls', '-a'], ['local', 'infra', 'git', 'status'],
    ['local', 'infra', 'cat', 'vault/x'], ['local', 'infra', 'cat', '/etc/hosts'], ['local', 'infra', 'ls;', 'id'],
    ['local', 'infra', 'rm', 'a.txt'], ['local', 'bad', 'ls'], ['local', 'broad', 'ls'],
    ['local', 'plainl', 'cat', path.join(base, 'kube.yaml')], ['local', 'nope', 'ls'],
  ];
  for (const args of checks) record(`check ${args.join(' ')}`, await cli(['check', ...args], checkEnv));
  record('check without arguments', await cli(['check'], checkEnv));
  record('check with an unknown kind', await cli(['check', 'db', 'x', 'ls'], checkEnv));
  record('check without a command', await cli(['check', 'ssh', 'web1'], checkEnv));

  const [deadPort] = await freePorts(1);
  const statusEnv = {
    ...process.env,
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg2'),
    KSPROXY_STATE_DIR: path.join(base, 'st2'),
    KSPROXY_SSH: fakeSsh,
  };
  const st = statusEnv.KSPROXY_STATE_DIR;
  fs.mkdirSync(path.join(st, 's'), { recursive: true });
  fs.writeFileSync(path.join(st, 's', 'ssh-web1'), '');
  const target = (extra) => ({ allow: [], state: 'up', ...extra });
  const statusPids = (text) => text.split(`session pid ${process.pid},`).join('session pid <pid>,');
  const first = await cli(['status'], statusEnv);
  record('status without a session', first);
  writeSession(path.join(st, 'session'), {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [
      target({
        kind: 'ssh', name: 'web1', host: 'web1.example.com', socket: path.join(st, 's', 'ssh-web1'),
      }),
      target({
        kind: 'ssh', name: 'web2', host: 'web2.example.com', socket: path.join(st, 's', 'ssh-web2'),
      }),
      target({ kind: 'kubernetes', name: 'lab', proxyPort: deadPort }),
      target({ kind: 'local', name: 'infra', cwd: work }),
      target({ kind: 'local', name: 'gone', cwd: path.join(base, 'missing') }),
    ],
  });
  const second = await cli(['status'], statusEnv);
  record('status with a session', { ...second, stdout: statusPids(second.stdout) });
  fs.mkdirSync(path.join(st, 'logs'), { recursive: true });
  const line = (entry) => JSON.stringify({ ts: TS, ...entry });
  fs.writeFileSync(path.join(st, 'logs', 'audit.log'), `${[
    line({ event: 'session_start' }),
    line({
      event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', exitCode: 0,
    }),
    line({
      event: 'call', tool: 'kubectl', kind: 'kube', target: 'lab', args: ['get', 'pods'], decision: 'refused', short: 'x',
    }),
    line({ event: 'list' }),
  ].join('\n')}\n`);
  const third = await cli(['status'], statusEnv);
  record('status with a log', { ...third, stdout: statusPids(third.stdout) });

  const st3 = path.join(base, 'st3');
  fs.mkdirSync(path.join(st3, 's'), { recursive: true });
  fs.writeFileSync(path.join(st3, 's', 'ssh-web1'), '');
  writeSession(path.join(st3, 'session'), {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [
      target({
        kind: 'ssh', name: 'web1', host: 'web1.example.com', socket: path.join(st3, 's', 'ssh-web1'),
      }),
      target({ kind: 'local', name: 'infra', cwd: work }),
    ],
  });
  const fourth = await cli(['status'], { ...statusEnv, KSPROXY_STATE_DIR: st3 });
  record('status with everything up', { ...fourth, stdout: statusPids(fourth.stdout) });

  golden('usage.txt', tidy(`${out.join('\n')}\n`));
});

test('golden: the request sent to the reviewer for one subject of each kind', () => {
  const reviewer = { model: 'test-model' };
  const review = { policy: 'read only' };
  const subjects = [
    { kind: 'ssh', name: 'web1', argv: ['df', '-h'] },
    { kind: 'kubernetes', name: 'lab', argv: ['get', 'pods', '-n', 'web'] },
    { kind: 'local', name: 'infra', argv: ['git', 'branch', '-a'] },
  ];
  golden('review-request.json', json(subjects.map((subject) => buildRequest(reviewer, review, subject))));
});
