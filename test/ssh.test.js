import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  masterArgs, controlArgs, sshConfigText, execArgs, openMaster, checkMaster, closeMaster,
} from '../src/kinds/ssh/master.js';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join('/tmp', 'ks-ssh-'));
}

test('masterArgs', () => {
  const base = [
    '-M', '-N', '-f', '-o', 'ControlPath=/s/x', '-o', 'ControlPersist=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
  ];
  assert.deepEqual(masterArgs('/s/x', 'h'), [...base, '--', 'h']);
  assert.deepEqual(masterArgs('/s/x', 'h', ['-L', 'a:b']), [...base, '-L', 'a:b', '--', 'h']);
});

test('controlArgs and execArgs', () => {
  assert.deepEqual(controlArgs('/s/x', 'check', 'h'), ['-S', '/s/x', '-O', 'check', 'h']);
  assert.deepEqual(controlArgs('/s/x', 'exit', 'h'), ['-S', '/s/x', '-O', 'exit', 'h']);
  assert.deepEqual(execArgs('/c/ssh_config', 'web1', 'df -h'), ['-F', '/c/ssh_config', '-T', 'web1', '--', 'df -h']);
});

test('sshConfigText has the credential-free block per target', () => {
  const text = sshConfigText([{ name: 'web1', socket: '/s/ssh-web1' }]);
  const lines = text.split('\n').map((l) => l.trim());
  for (const want of [
    'Host web1', 'HostName ksproxy.invalid', 'ControlPath /s/ssh-web1', 'ControlMaster no',
    'BatchMode yes', 'IdentityAgent none', 'IdentitiesOnly yes', 'IdentityFile /dev/null',
    'PubkeyAuthentication no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'ProxyCommand /usr/bin/false', 'UserKnownHostsFile /dev/null',
  ]) {
    assert.ok(lines.includes(want), `missing line: ${want}`);
  }
  const two = sshConfigText([
    { name: 'a', socket: '/s/ssh-a' },
    { name: 'b', socket: '/s/ssh-b' },
  ]);
  assert.equal(two.split('\n').filter((l) => l.startsWith('Host ')).length, 2);
});

test('master lifecycle with the stub', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'ssh-web1');
  const env = { ...process.env, KSPROXY_SSH: fakeSsh };
  assert.deepEqual(await openMaster({ socket, host: 'h' }, env), { ok: true });
  assert.equal(fs.existsSync(socket), true);
  assert.equal(await checkMaster({ socket, host: 'h' }, env), true);
  await closeMaster({ socket, host: 'h' }, env);
  assert.equal(fs.existsSync(socket), false);
  assert.equal(await checkMaster({ socket, host: 'h' }, env), false);
});

test('openMaster reports a failing host', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'ssh-bad');
  const env = { ...process.env, KSPROXY_SSH: fakeSsh, KSPROXY_FAKE_SSH_FAIL_HOST: 'badhost' };
  const r = await openMaster({ socket, host: 'badhost' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /255/);
  assert.equal(fs.existsSync(socket), false);
});

test('closeMaster never throws when the binary is missing', async () => {
  const dir = tmp();
  await closeMaster({ socket: path.join(dir, 'x'), host: 'h' }, { KSPROXY_SSH: '/nonexistent/ssh' });
});
