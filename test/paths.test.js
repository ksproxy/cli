import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expandHome, configDir, inventoryPath, stateDir, sessionDir, socketDir, socketPath,
  sshBin, kubectlBin, ensureDir, writeFileAtomic,
} from '../src/paths.js';

function tmp() {
  return fs.mkdtempSync(path.join('/tmp', 'ks-paths-'));
}

test('expandHome', () => {
  assert.equal(expandHome('~/a'), path.join(os.homedir(), 'a'));
  assert.equal(expandHome('/x'), '/x');
  assert.equal(expandHome('~'), os.homedir());
});

test('configDir and inventoryPath', () => {
  assert.equal(configDir({ KSPROXY_CONFIG_DIR: '/c' }), '/c');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }), '/x/ksproxy');
  assert.equal(configDir({}), path.join(os.homedir(), '.config', 'ksproxy'));
  assert.equal(inventoryPath({ KSPROXY_CONFIG_DIR: '/c' }), '/c/inventory.json');
});

test('state, session and socket dirs', () => {
  const env = { KSPROXY_STATE_DIR: '/s' };
  assert.equal(stateDir(env), '/s');
  assert.equal(sessionDir(env), '/s/session');
  assert.equal(socketDir(env), '/s/s');
  assert.equal(stateDir({}), path.join(os.homedir(), '.ksproxy'));
});

test('socketPath', () => {
  assert.equal(socketPath('ssh', 'web1', { KSPROXY_STATE_DIR: '/s' }), '/s/s/ssh-web1');
  assert.throws(
    () => socketPath('ssh', 'web1', { KSPROXY_STATE_DIR: '/' + 'x'.repeat(120) }),
    /too long/,
  );
});

test('sshBin and kubectlBin', () => {
  assert.equal(sshBin({}), 'ssh');
  assert.equal(sshBin({ KSPROXY_SSH: '/f' }), '/f');
  assert.equal(kubectlBin({}), 'kubectl');
  assert.equal(kubectlBin({ KSPROXY_KUBECTL: '/f' }), '/f');
});

test('ensureDir creates nested dir with mode 0700', () => {
  const dir = path.join(tmp(), 'a', 'b');
  ensureDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('writeFileAtomic writes 0600 and leaves no tmp file', () => {
  const dir = tmp();
  const file = path.join(dir, 'f.txt');
  writeFileAtomic(file, 'hello');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('writeFileAtomic succeeds twice in a row and leaves no temp file', () => {
  const dir = tmp();
  const file = path.join(dir, 'f.txt');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['f.txt']);
});
