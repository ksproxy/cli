import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeMaster, openMaster } from '../src/kinds/ssh/master.js';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const nostay = fileURLToPath(new URL('./fixtures/fake-ssh-nostay.js', import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join('/tmp', 'ks-ssx-'));
}

function envWith(extra) {
  return { ...process.env, ...extra };
}

test('closeMaster never throws: a broken environment still removes the socket file', async () => {
  const dir = tmp();
  try {
    const socket = path.join(dir, 'sock');
    fs.writeFileSync(socket, '');
    await closeMaster({ socket, host: 'h' }, null);
    assert.equal(fs.existsSync(socket), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closeMaster never throws: a socket path that cannot be removed is left alone', async () => {
  const dir = tmp();
  try {
    const socket = path.join(dir, 'sock');
    fs.mkdirSync(path.join(socket, 'inner'), { recursive: true });
    await closeMaster({ socket, host: 'h' }, envWith({ KSPROXY_SSH: path.join(dir, 'no-such-ssh') }));
    assert.equal(fs.existsSync(path.join(socket, 'inner')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openMaster reports a program that cannot be started', async () => {
  const dir = tmp();
  try {
    const result = await openMaster(
      { socket: path.join(dir, 'sock'), host: 'h' },
      envWith({ KSPROXY_SSH: path.join(dir, 'no-such-ssh') }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openMaster reports a connection that exits cleanly but is not open afterwards', async () => {
  const dir = tmp();
  try {
    const result = await openMaster(
      { socket: path.join(dir, 'sock'), host: 'h' },
      envWith({ KSPROXY_SSH: nostay }),
    );
    assert.deepEqual(result, { ok: false, error: 'the connection did not stay open' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openMaster reports ssh exiting with an error code and succeeds with the stub', async () => {
  const dir = tmp();
  try {
    const socket = path.join(dir, 'sock');
    const failing = await openMaster(
      { socket, host: 'bad' },
      envWith({ KSPROXY_SSH: fakeSsh, KSPROXY_FAKE_SSH_FAIL_HOST: 'bad' }),
    );
    assert.deepEqual(failing, { ok: false, error: 'ssh exited with code 255' });
    const good = await openMaster({ socket, host: 'good' }, envWith({ KSPROXY_SSH: fakeSsh }));
    assert.deepEqual(good, { ok: true });
    await closeMaster({ socket, host: 'good' }, envWith({ KSPROXY_SSH: fakeSsh }));
    assert.equal(fs.existsSync(socket), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
