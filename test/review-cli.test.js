import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { agentMdText } from '../src/agent-md.js';
import { fakeProcess } from './start-helpers.js';

const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const review = { reviewer: 'r1', policy: 'read-only' };

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-rc-')));
  dirs.push(base);
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  const env = {
    ...process.env,
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
    KSPROXY_STATE_DIR: path.join(base, 'st'),
  };
  fs.mkdirSync(env.KSPROXY_CONFIG_DIR);
  const inventory = {
    reviewers: { r1: { baseUrl: 'http://127.0.0.1:9/v1/', model: 'm' } },
    ssh: [
      { name: 'web1', host: 'web1.example.com', allow: ['uptime'], review },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
    ],
    kubernetes: [{
      name: 'lab', kubeconfig: '/tmp/none.yaml', proxyPort: 18002, allow: [], review,
    }],
    local: [{
      name: 'loc', cwd: proj, allow: ['pwd'], review: { ...review, programs: ['ls'] },
    }],
  };
  fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify(inventory));
  return env;
}

const env = world();

async function runCli(args) {
  const proc = fakeProcess();
  const code = await main(['check', ...args], env, { process: proc });
  return { code, stdout: proc.stdout.text };
}

test('check says a running session would ask the reviewer', async () => {
  const { code, stdout } = await runCli(['ssh', 'web1', 'df', '-h']);
  assert.equal(code, 1);
  assert.equal(stdout.trim(), 'NOT ON THE ALLOWLIST: a running session asks reviewer "r1"');
});

test('check is unchanged for a listed command, a plain target, a write verb and a fixed refusal', async () => {
  assert.match((await runCli(['ssh', 'web1', 'uptime'])).stdout, /^ALLOWED by rule: uptime/);
  assert.match((await runCli(['ssh', 'web2', 'df'])).stdout, /^REFUSED: not on the allowlist/);
  assert.match((await runCli(['kube', 'lab', 'delete', 'pod', 'x'])).stdout, /^REFUSED: /);
  assert.match((await runCli(['kube', 'lab', 'get', 'secrets'])).stdout, /^REFUSED: /);
  assert.match((await runCli(['kube', 'lab', 'get', 'pods'])).stdout, /^NOT ON THE ALLOWLIST: a running session asks reviewer "r1"/);
});

test('check for a local target needs a listed program and plain arguments', async () => {
  assert.match((await runCli(['local', 'loc', 'ls', '-a'])).stdout, /^NOT ON THE ALLOWLIST: a running session asks reviewer "r1"/);
  assert.match((await runCli(['local', 'loc', 'cat', 'a.txt'])).stdout, /^REFUSED: not on the allowlist/);
  assert.match((await runCli(['local', 'loc', 'pwd'])).stdout, /^ALLOWED by rule: pwd/);
});

test('check says why a refused command on a reviewed target would not reach the reviewer', async () => {
  const cases = [
    [['kube', 'lab', 'delete', 'pod', 'x'], 'only read verbs are reviewed, and delete is not one'],
    [['kube', 'lab', 'get', 'pods', '-l', 'a"b'], 'a word contains a space, a control character or a double quote'],
    [['ssh', 'web1', 'LD_PRELOAD=x', 'uptime'], 'the first word sets an environment variable on the server'],
    [['local', 'loc', 'cat', 'a.txt'], 'the program cat is not one the reviewer may approve for this target'],
    [['local', 'loc', 'ls', '--color=auto'], 'the argument --color=auto is neither a simple flag nor a plain name or path'],
  ];
  for (const [args, why] of cases) {
    const { code, stdout } = await runCli(args);
    assert.equal(code, 1);
    assert.match(stdout, /^REFUSED: /);
    assert.ok(stdout.trim().endsWith(` It was not sent to the reviewer: ${why}.`), stdout);
  }
  assert.doesNotMatch((await runCli(['ssh', 'web2', 'LD_PRELOAD=x', 'uptime'])).stdout, /reviewer/);
  assert.doesNotMatch((await runCli(['kube', 'lab', 'get', 'secrets'])).stdout, /reviewer/);
});

test('AGENT.md tells the agent which targets are reviewed', () => {
  const line = '- A command that is not on this list is reviewed before it runs and may be refused.';
  const base = { description: '', allow: ['uptime'], state: 'up' };
  const text = agentMdText({
    targets: [
      { ...base, kind: 'ssh', name: 'web1', review: true },
      { ...base, kind: 'ssh', name: 'web2' },
      { ...base, kind: 'kubernetes', name: 'lab', manifestRoots: [], review: true },
      {
        ...base, kind: 'local', name: 'loc', review: true, programs: ['ls', 'git'],
      },
    ],
  });
  assert.equal(text.split(line).length - 1, 3);
  assert.ok(text.includes('Only these programs can be reviewed: ls, git.'));
});
