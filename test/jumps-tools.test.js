import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../src/tools.js';
import sshKind from '../src/kinds/ssh/index.js';
import { writeSession } from '../src/session.js';

const decideSsh = sshKind.decide;

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));

const JUMP = 'ssh -i .ssh/prod_rsa ubuntu@172.16.1.210';
const PREFIX = 'ssh -T -o BatchMode=yes -i .ssh/prod_rsa -o ConnectTimeout=10 ubuntu@172.16.1.210 --';
const SECRETS = ['prod_rsa', '172.16', 'ubuntu', '.ssh', 'BatchMode'];

let base;
let env;
let sshLog;
const asked = [];

const fakeReview = (reply) => async (socket, subject) => {
  asked.push({ socket, subject });
  return reply;
};
const audit = () => fs.readFileSync(path.join(base, 'logs', 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastAudit = () => audit().pop();

function target(name, extra) {
  return {
    kind: 'ssh', name, description: '', allow: ['uptime', 'systemctl status *', 'journalctl -u app ...'], host: `h-${name}`,
    socket: path.join(base, 's', 'ssh-x'), state: 'up', ...extra,
  };
}

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-jt-')));
  const sessionDir = path.join(base, 'session');
  fs.mkdirSync(path.join(base, 's'));
  fs.mkdirSync(path.join(base, 'logs'));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
  fs.writeFileSync(path.join(sessionDir, 'kubeconfig'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-x'), '');
  sshLog = path.join(base, 'ssh.log');
  env = { ...process.env, KSPROXY_STATE_DIR: base, KSPROXY_SSH: fakeSsh };
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-21T00:00:00.000Z',
    targets: [
      target('one', { jumps: [JUMP] }),
      target('two', { jumps: ['ssh -i a u@b', 'ssh -p 2222 v@c'] }),
      target('anyj', { allow: 'any', jumps: [JUMP] }),
      target('badj', { jumps: ['ssh -A u@h'] }),
      target('nulj', { jumps: null }),
      target('emptyj', { jumps: [] }),
      target('echoj', { allow: ['echo ...'], jumps: [JUMP] }),
      target('plain', {}),
      target('rev', { jumps: [JUMP], review: true }),
    ],
  });
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

const sshRuns = () => (fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const runEnv = () => ({ ...env, KSPROXY_FAKE_SSH_LOG: sshLog });

test('one jump puts the fixed prefix before the command', async () => {
  const r = await callTool('ssh_exec', { server: 'one', command: 'uptime' }, runEnv());
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`ran one ${PREFIX} uptime\$`));
  const last = sshRuns().pop();
  assert.equal(last[last.length - 1], `${PREFIX} uptime`);
  assert.equal(last.length, 6);
});

test('two jumps nest in order', async () => {
  const r = await callTool('ssh_exec', { server: 'two', command: 'uptime' }, runEnv());
  assert.equal(r.isError, false, r.text);
  assert.match(
    r.text,
    /ran two ssh -T -o BatchMode=yes -i a -o ConnectTimeout=10 u@b -- ssh -T -o BatchMode=yes -p 2222 -o ConnectTimeout=10 v@c -- uptime$/,
  );
});

test('words that look like options land after the fixed "--" of the last hop', async () => {
  const r = await callTool('ssh_exec', { server: 'echoj', command: 'echo a -- -oProxyCommand=x' }, runEnv());
  assert.equal(r.isError, false, r.text);
  const last = sshRuns().pop();
  assert.equal(last[last.length - 1], `${PREFIX} echo a -- -oProxyCommand=x`);
  assert.equal(last[last.length - 1].indexOf('-oProxyCommand=x') > last[last.length - 1].indexOf(' -- '), true);
});

test('extra words from a "..." rule come after the command', async () => {
  const r = await callTool('ssh_exec', { server: 'one', command: 'journalctl -u app -n 50 --no-pager' }, runEnv());
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`ran one ${PREFIX} journalctl -u app -n 50 --no-pager\$`));
});

test('a word that zsh may rewrite is refused and nothing runs', async () => {
  const before = sshRuns().length;
  for (const command of ['uptime =ls', 'systemctl status =ls', 'systemctl status x==ls', 'systemctl status a=b:=c']) {
    const r = await callTool('ssh_exec', { server: 'one', command }, runEnv());
    assert.equal(r.isError, true);
    assert.equal(r.text, 'REFUSED (ssh one): a word may not start with "=" or contain "==" or ":=" on a target with jumps');
    assert.equal(lastAudit().short, 'unsafe "=" word');
  }
  assert.equal(sshRuns().length, before);
});

test('allow "any" in the session is refused and nothing runs', async () => {
  const before = sshRuns().length;
  const r = await callTool('ssh_exec', { server: 'anyj', command: 'uptime' }, runEnv());
  assert.equal(r.isError, true);
  assert.equal(r.text, 'REFUSED (ssh anyj): a target with jumps needs a list of rules, not "any"');
  assert.equal(lastAudit().short, 'allowlist is "any"');
  assert.equal(sshRuns().length, before);
});

test('jumps that cannot be used are refused and the ssh program is never started', async () => {
  const before = sshRuns().length;
  for (const name of ['badj', 'nulj', 'emptyj']) {
    const r = await callTool('ssh_exec', { server: name, command: 'uptime' }, runEnv());
    assert.equal(r.isError, true);
    assert.equal(r.text, `REFUSED (ssh ${name}): this target's jumps are not usable; ask the user to restart ksproxy start`);
    assert.equal(lastAudit().short, 'jumps not usable');
  }
  assert.equal(sshRuns().length, before);
});

test('these refusals carry neither unmatched nor argv', () => {
  const cases = [
    [{ allow: ['uptime'], jumps: [JUMP] }, 'uptime =x'],
    [{ allow: ['uptime'], jumps: [JUMP] }, 'uptime x==y'],
    [{ allow: ['uptime'], jumps: [JUMP] }, 'uptime a=b:=c'],
    [{ allow: 'any', jumps: [JUMP] }, 'uptime'],
    [{ allow: ['uptime'], jumps: [] }, 'uptime'],
  ];
  for (const [t, command] of cases) {
    const d = decideSsh(t, command);
    assert.equal(d.allowed, false);
    assert.equal(Object.hasOwn(d, 'unmatched'), false);
    assert.equal(Object.hasOwn(d, 'argv'), false);
  }
});

test('the decision carries the prefix only for a target with jumps', () => {
  const jumped = { allow: ['uptime'], jumps: [JUMP] };
  const plain = { allow: ['uptime'] };
  assert.deepEqual(decideSsh(jumped, 'uptime'), { allowed: true, rule: 'uptime', command: 'uptime', prefix: PREFIX });
  assert.deepEqual(decideSsh(plain, 'uptime'), { allowed: true, rule: 'uptime', command: 'uptime' });
  const unmatched = decideSsh(jumped, 'df -h');
  assert.equal(unmatched.allowed, false);
  assert.equal(unmatched.unmatched, true);
  assert.deepEqual(unmatched.argv, ['df', '-h']);
  assert.equal(unmatched.prefix, PREFIX);
  const unmatchedPlain = decideSsh(plain, 'df -h');
  assert.deepEqual(unmatchedPlain.argv, ['df', '-h']);
  assert.equal(Object.hasOwn(unmatchedPlain, 'prefix'), false);
  assert.deepEqual(decideSsh({ allow: 'any' }, 'uptime'), { allowed: true, rule: 'any', command: 'uptime' });
});

test('a target without jumps sends exactly the old command', async () => {
  const r = await callTool('ssh_exec', { server: 'plain', command: 'uptime' }, runEnv());
  assert.equal(r.isError, false, r.text);
  const last = sshRuns().pop();
  assert.equal(last[last.length - 1], 'uptime');
  assert.equal(r.text, 'exit code: 0\n--- stdout ---\nran plain uptime');
});

test('a call approved by the reviewer runs with the prefix', async () => {
  asked.length = 0;
  const r = await callTool('ssh_exec', { server: 'rev', command: 'df  -h' }, runEnv(), {
    review: fakeReview({ allowed: true, certainty: 'sure', reason: 'disk usage' }),
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`ran rev ${PREFIX} df -h\$`));
  assert.deepEqual(asked[0].subject.argv, ['df', '-h']);
  assert.equal(lastAudit().command, 'df  -h');
});

test('a command with a word zsh may rewrite is never sent to the reviewer', async () => {
  asked.length = 0;
  for (const command of ['df =ls', 'df x==ls', 'df a=b:=c']) {
    const r = await callTool('ssh_exec', { server: 'rev', command }, runEnv(), {
      review: fakeReview({ allowed: true, certainty: 'sure', reason: '' }),
    });
    assert.equal(r.isError, true);
  }
  assert.equal(asked.length, 0);
});

test('a command the reviewer refuses does not run', async () => {
  const before = sshRuns().length;
  const r = await callTool('ssh_exec', { server: 'rev', command: 'df -h' }, runEnv(), {
    review: fakeReview({ allowed: false, short: 'no' }),
  });
  assert.equal(r.isError, true);
  assert.equal(sshRuns().length, before);
});

test('list_targets and the usual refusals show no part of the jump text', async () => {
  const listed = await callTool('list_targets', {}, env);
  assert.equal(listed.isError, false);
  assert.equal(listed.text.includes('jumps'), false);
  for (const word of SECRETS) assert.equal(listed.text.includes(word), false, word);
  const refusals = [
    await callTool('ssh_exec', { server: 'one', command: 'rm -rf x' }, env),
    await callTool('ssh_exec', { server: 'one', command: 'uptime; ls' }, env),
    await callTool('ssh_exec', { server: 'one', command: 'ssh -i k h' }, env),
    await callTool('ssh_exec', { server: 'one', command: '' }, env),
    await callTool('ssh_exec', { server: 'nope', command: 'uptime' }, env),
  ];
  for (const r of refusals) {
    assert.equal(r.isError, true);
    assert.equal(r.text.includes('jumps'), false, r.text);
    for (const word of SECRETS) assert.equal(r.text.includes(word), false, r.text);
  }
  for (const name of ['anyj', 'badj']) {
    const r = await callTool('ssh_exec', { server: name, command: 'uptime' }, env);
    for (const word of SECRETS) assert.equal(r.text.includes(word), false, r.text);
  }
});

test('the audit entry holds the agent command and nothing of the jump', async () => {
  const r = await callTool('ssh_exec', { server: 'one', command: 'systemctl  status nginx' }, runEnv());
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text.includes('sent to'), false);
  const entry = lastAudit();
  assert.equal(entry.command, 'systemctl  status nginx');
  assert.equal(entry.rule, 'systemctl status *');
  const text = JSON.stringify(audit());
  for (const word of SECRETS) assert.equal(text.includes(word), false, word);
});
