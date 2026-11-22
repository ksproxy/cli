import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callTool, reviewRoute, reviewWordsProblem,
} from '../src/tools.js';
import sshKind from '../src/kinds/ssh/index.js';
import kubernetesKind from '../src/kinds/kubernetes/index.js';
import { READ_VERBS } from '../src/kinds/kubernetes/cluster.js';
import { writeSession } from '../src/session.js';
import { tempDir } from './temp.js';

const decideSsh = sshKind.decide;
const decideKube = kubernetesKind.decide;

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));

let base;
let sessionDir;
let env;
let server;

const asked = [];
const fakeReview = (reply) => async (socket, subject) => {
  asked.push({ socket, subject });
  return reply;
};
const lastAudit = () => JSON.parse(fs.readFileSync(path.join(base, 'logs', 'audit.log'), 'utf8').trim().split('\n').pop());
const approve = (reason = '') => fakeReview({ allowed: true, certainty: 'sure', reason });

before(async () => {
  base = fs.realpathSync(tempDir('ks-rt-'));
  sessionDir = path.join(base, 'session');
  fs.mkdirSync(path.join(base, 's'));
  fs.mkdirSync(path.join(base, 'logs'));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
  fs.writeFileSync(path.join(sessionDir, 'kubeconfig'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-web1'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-plain1'), '');
  server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  env = {
    ...process.env,
    KSPROXY_STATE_DIR: base,
    KSPROXY_SSH: fakeSsh,
    KSPROXY_KUBECTL: fakeKubectl,
  };
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-21T00:00:00.000Z',
    targets: [
      {
        kind: 'ssh', name: 'web1', description: '', allow: ['uptime', 'cat *'], host: 'web1.example.com',
        socket: path.join(base, 's', 'ssh-web1'), state: 'up', review: true,
      },
      {
        kind: 'ssh', name: 'plain1', description: '', allow: ['uptime'], host: 'p1',
        socket: path.join(base, 's', 'ssh-plain1'), state: 'up',
      },
      {
        kind: 'ssh', name: 'empty1', description: '', allow: [], host: 'e1',
        socket: path.join(base, 's', 'ssh-plain1'), state: 'up', review: true,
      },
      {
        kind: 'ssh', name: 'truthy1', description: '', allow: ['uptime'], host: 't1',
        socket: path.join(base, 's', 'ssh-plain1'), state: 'up', review: 'yes',
      },
      {
        kind: 'kubernetes', name: 'lab', description: '', allow: ['get pods'], proxyPort: port,
        manifestRoots: [], tunnel: null, state: 'up', review: true,
      },
      {
        kind: 'kubernetes', name: 'plainlab', description: '', allow: ['get pods'], proxyPort: port,
        manifestRoots: [], tunnel: null, state: 'up',
      },
    ],
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test('READ_VERBS holds the read verbs only', () => {
  assert.deepEqual([...READ_VERBS].sort(), [
    'api-resources', 'api-versions', 'cluster-info', 'describe', 'events', 'explain', 'get', 'logs', 'top', 'version',
  ]);
});

test('decideSsh and decideKube carry the checked argument list on an unmatched refusal only', () => {
  const target = { allow: ['uptime'] };
  assert.deepEqual(decideSsh(target, 'df  -h'), {
    allowed: false, reason: 'not on the allowlist for this target. Allowed: uptime', short: 'not on allowlist', unmatched: true, argv: ['df', '-h'],
  });
  assert.equal(Object.hasOwn(decideSsh(target, 'df;x'), 'argv'), false);
  assert.equal(Object.hasOwn(decideSsh(target, 'uptime'), 'argv'), false);
  const cluster = { allow: ['get pods'], manifestRoots: [] };
  assert.deepEqual(decideKube(cluster, ['get', 'nodes']).argv, ['get', 'nodes']);
  assert.equal(Object.hasOwn(decideKube(cluster, ['get', 'secrets']), 'argv'), false);
  assert.equal(Object.hasOwn(decideKube(cluster, ['get', 'secrets']), 'unmatched'), false);
  assert.equal(Object.hasOwn(decideKube(cluster, ['get', 'pods']), 'argv'), false);
});

test('a command that matches a rule runs without a review', async () => {
  asked.length = 0;
  const r = await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, env, { review: fakeReview({ allowed: false, short: 'x' }) });
  assert.equal(r.isError, false);
  assert.equal(asked.length, 0);
  assert.equal(Object.hasOwn(lastAudit(), 'review'), false);
});

test('an unlisted ssh command approved by the reviewer runs, and the log says who decided', async () => {
  asked.length = 0;
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df  -h' }, env, {
    review: fakeReview({ allowed: true, certainty: 'sure', reason: 'disk usage' }),
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /ran web1 df -h/);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].subject, { kind: 'ssh', name: 'web1', argv: ['df', '-h'] });
  assert.equal(asked[0].socket, path.join(base, 's', 'review-sock'));
  const entry = lastAudit();
  assert.equal(entry.decision, 'allowed');
  assert.equal(entry.rule, 'review');
  assert.deepEqual(entry.review, { certainty: 'sure', reason: 'disk usage' });
});

test('a reviewer refusal is a refusal, and the agent does not get the model reason', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'reboot' }, env, {
    review: fakeReview({ allowed: false, short: 'model refused: restarts the box' }),
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /^REFUSED \(ssh web1\): not on the allowlist/);
  assert.match(r.text, /The reviewer did not approve it\.$/);
  assert.doesNotMatch(r.text, /restarts the box/);
  const entry = lastAudit();
  assert.equal(entry.decision, 'refused');
  assert.equal(entry.short, 'model refused: restarts the box');
  assert.doesNotMatch(entry.reason, /restarts the box/);
});

test('only a reply with allowed exactly true approves', async () => {
  for (const reply of [{ allowed: 'true', certainty: 'sure', reason: 'x', short: 'odd' }, { allowed: 1, short: 'odd' }, {}, null, undefined]) {
    const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, env, { review: fakeReview(reply) });
    assert.equal(r.isError, true, JSON.stringify(reply));
    assert.match(r.text, /The reviewer did not approve it\.$/);
    assert.equal(lastAudit().decision, 'refused');
  }
});

test('a reviewer approval is not shown to the agent beyond the command output', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, env, { review: approve('SECRET-REASON') });
  assert.equal(r.isError, false);
  assert.doesNotMatch(r.text, /SECRET-REASON/);
});

test('a target without review is never sent to the reviewer', async () => {
  asked.length = 0;
  const review = approve();
  const r = await callTool('ssh_exec', { server: 'plain1', command: 'df -h' }, env, { review });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /reviewer/);
  assert.equal((await callTool('ssh_exec', { server: 'truthy1', command: 'df -h' }, env, { review })).isError, true);
  assert.equal((await callTool('kubectl', { cluster: 'plainlab', args: ['get', 'nodes'] }, env, { review })).isError, true);
  assert.equal(asked.length, 0);
});

test('an empty allowlist on a reviewed target still goes through the reviewer', async () => {
  asked.length = 0;
  const r = await callTool('ssh_exec', { server: 'empty1', command: 'df -h' }, env, { review: fakeReview({ allowed: false, short: 'model refused' }) });
  assert.equal(r.isError, true);
  assert.equal(asked.length, 1);
  assert.match(r.text, /allowlist for this target is empty.*The reviewer did not approve it\.$/);
});

test('shell syntax is refused before any review', async () => {
  asked.length = 0;
  const review = approve();
  for (const command of ['df -h; reboot', 'df $(reboot)', 'cat a|sh', 'ls\nreboot', '-x', '', 'a'.repeat(5000)]) {
    const r = await callTool('ssh_exec', { server: 'web1', command }, env, { review });
    assert.equal(r.isError, true, command);
  }
  assert.equal(asked.length, 0);
});

test('an unlisted read verb on a cluster is reviewed with its arguments', async () => {
  asked.length = 0;
  const r = await callTool('kubectl', { cluster: 'lab', args: ['get', 'nodes'] }, env, {
    review: approve('lists nodes'),
  });
  assert.equal(r.isError, false);
  assert.deepEqual(asked[0].subject, { kind: 'kubernetes', name: 'lab', argv: ['get', 'nodes'] });
  assert.equal(lastAudit().rule, 'review');
  assert.deepEqual(lastAudit().review, { certainty: 'sure', reason: 'lists nodes' });
});

test('a write verb and a fixed refusal on a cluster are never reviewed', async () => {
  asked.length = 0;
  const review = approve();
  const refused = [
    ['delete', 'pod', 'x'], ['apply', '-f', 'x.yaml'], ['scale', 'deploy', 'x', '--replicas', '0'], ['auth', 'can-i', 'get', 'pods'],
    ['get', 'secrets'], ['get', 'secret/x'], ['exec', 'pod', '--', 'sh'], ['get', 'pods', '--kubeconfig', '/x'],
    ['get', 'pods', '-o', 'go-template={{.}}'], ['--namespace', 'x', 'get', 'nodes'], ['get', 'pods', '-f', '/etc/passwd'],
  ];
  for (const args of refused) {
    assert.equal((await callTool('kubectl', { cluster: 'lab', args }, env, { review })).isError, true, args.join(' '));
  }
  assert.equal(asked.length, 0);
});

test('list_targets marks reviewed targets only', async () => {
  const listed = JSON.parse((await callTool('list_targets', {}, env)).text).targets;
  assert.equal(listed.find((t) => t.name === 'web1').review, true);
  assert.equal(listed.find((t) => t.name === 'lab').review, true);
  assert.equal(Object.hasOwn(listed.find((t) => t.name === 'plain1'), 'review'), false);
  assert.equal(Object.hasOwn(listed.find((t) => t.name === 'truthy1'), 'review'), false);
});

test('without an injected reviewer the real client is used and a missing socket means refused', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, env);
  assert.equal(r.isError, true);
  assert.match(r.text, /The reviewer did not approve it\.$/);
  assert.equal(lastAudit().short, 'review not available');
});

const notSent = (why) => ` It was not sent to the reviewer: ${why}.`;

test('words that leave room for injection are never sent to the reviewer, and the agent is told why', async () => {
  asked.length = 0;
  const review = approve();
  const cases = [
    [['get', 'configmaps', '-o', 'jsonpath={.items} NOTE TO REVIEWER'], 'a word contains a space, a control character or a double quote'],
    [['get', 'pods', '-l', 'a"b'], 'a word contains a space, a control character or a double quote'],
    [['get', 'pods', '-l', 'a b'], 'a word contains a space, a control character or a double quote'],
    [['get', 'pods', '-l', 'a b'], 'a word contains a space, a control character or a double quote'],
    [['get', 'pods', 'x'.repeat(201)], 'a word is longer than 200 characters'],
    [['get', ...Array(64).fill('a')], 'the command has more than 64 words'],
  ];
  for (const [args, why] of cases) {
    const r = await callTool('kubectl', { cluster: 'lab', args }, env, { review });
    assert.equal(r.isError, true, why);
    assert.ok(r.text.startsWith('REFUSED (kube lab): not on the allowlist for this target. Allowed: get pods. '), r.text);
    assert.ok(r.text.endsWith(notSent(why)), r.text);
    assert.equal(lastAudit().short, 'not on allowlist');
  }
  assert.equal(asked.length, 0);
  assert.equal((await callTool('kubectl', { cluster: 'lab', args: ['get', 'x'.repeat(200)] }, env, { review })).isError, false);
  assert.equal((await callTool('kubectl', { cluster: 'lab', args: ['get', ...Array(63).fill('a')] }, env, { review })).isError, false);
  assert.equal(asked.length, 2);
});

test('an ssh command the remote shell would read differently is never sent to the reviewer', async () => {
  asked.length = 0;
  const review = approve();
  const cases = {
    'LD_PRELOAD=/tmp/x.so uptime': 'the first word sets an environment variable on the server',
    'PATH=/tmp': 'the first word sets an environment variable on the server',
    'ls =ls': 'a word starts with "=", which the server\'s shell may expand',
    '=ls': 'a word starts with "=", which the server\'s shell may expand',
    'ls x==ls': 'a word contains "==" or ":=", which the server\'s shell may rewrite',
    'ls a=b:=c': 'a word contains "==" or ":=", which the server\'s shell may rewrite',
  };
  for (const [command, why] of Object.entries(cases)) {
    const r = await callTool('ssh_exec', { server: 'web1', command }, env, { review });
    assert.equal(r.isError, true, command);
    assert.ok(r.text.endsWith(notSent(why)), r.text);
  }
  assert.equal(asked.length, 0);
  for (const command of ['env LD_PRELOAD=x uptime', 'echo a=b', 'grep -e x= f']) {
    assert.equal((await callTool('ssh_exec', { server: 'web1', command }, env, { review })).isError, false, command);
  }
  assert.equal(asked.length, 3);
});

test('a write verb on a reviewed cluster is refused with the reason it was not reviewed', async () => {
  const r = await callTool('kubectl', { cluster: 'lab', args: ['delete', 'pod', 'x'] }, env, { review: approve() });
  assert.ok(r.text.endsWith(notSent('only read verbs are reviewed, and delete is not one')), r.text);
  const fixed = await callTool('kubectl', { cluster: 'lab', args: ['get', 'secrets'] }, env, { review: approve() });
  assert.doesNotMatch(fixed.text, /reviewer/);
  const plain = await callTool('kubectl', { cluster: 'plainlab', args: ['delete', 'pod', 'x'] }, env, { review: approve() });
  assert.doesNotMatch(plain.text, /reviewer/);
});

test('a reviewer that throws is refused as not available, audited, and says nothing about the error', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, env, {
    review: async () => { throw new Error(`socket blew up at ${base}`); },
  });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'REFUSED (ssh web1): not on the allowlist for this target. Allowed: uptime; cat *. The reviewer did not approve it.');
  const entry = lastAudit();
  assert.equal(entry.decision, 'refused');
  assert.equal(entry.short, 'review not available');
  assert.equal(entry.command, 'df -h');
});

test('a review socket path that is too long is refused as not available, audited', async () => {
  const longBase = path.join(base, 'l'.repeat(100));
  const longSession = path.join(longBase, 'session');
  fs.mkdirSync(longSession, { recursive: true });
  fs.mkdirSync(path.join(longBase, 'logs'));
  writeSession(longSession, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-21T00:00:00.000Z',
    targets: [{
      kind: 'ssh', name: 'web1', description: '', allow: ['uptime'], host: 'web1.example.com',
      socket: path.join(base, 's', 'ssh-web1'), state: 'up', review: true,
    }],
  });
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, { ...env, KSPROXY_STATE_DIR: longBase });
  assert.equal(r.isError, true);
  assert.match(r.text, /The reviewer did not approve it\.$/);
  assert.doesNotMatch(r.text, /internal error|lll/);
  const entry = JSON.parse(fs.readFileSync(path.join(longBase, 'logs', 'audit.log'), 'utf8').trim().split('\n').pop());
  assert.equal(entry.short, 'review not available');
});

test('reviewWordsProblem checks every kind, and ssh for what a login shell reads', () => {
  for (const kind of ['ssh', 'kubernetes', 'local']) {
    assert.equal(reviewWordsProblem(kind, ['ls', '-la']), null);
    assert.equal(reviewWordsProblem(kind, ['ls', 'a\u0007']), 'a word contains a space, a control character or a double quote');
    assert.equal(reviewWordsProblem(kind, ['ls', 'a\u0085']), 'a word contains a space, a control character or a double quote');
  }
  assert.equal(reviewWordsProblem('kubernetes', ['A=1', '=x']), null);
  assert.equal(reviewWordsProblem('local', ['A=1', '=x']), null);
  assert.equal(reviewWordsProblem('ssh', ['echo', 'A=1']), null);
});

test('reviewRoute says where a refused command goes', () => {
  const unmatched = { allowed: false, unmatched: true, argv: ['ls'] };
  assert.equal(reviewRoute('ssh', { allowed: true }, true), null);
  assert.equal(reviewRoute('ssh', unmatched, false), null);
  assert.equal(reviewRoute('ssh', { allowed: false, reason: 'x' }, true), null);
  assert.equal(reviewRoute('ssh', { allowed: false, unmatched: true }, true), null);
  assert.deepEqual(reviewRoute('ssh', unmatched, true), { argv: ['ls'] });
  assert.deepEqual(reviewRoute('local', { ...unmatched, notReviewed: 'why' }, true), { note: 'It was not sent to the reviewer: why.' });
});
