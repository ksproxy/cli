import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_KEY, PROJECT_RE, PROJECT_RULE, auditLogPath, callSocketPath, initCommand, inventoryPath, logDir, projectOf,
  projectsDir, reviewSocketPath, rootStateDir, sessionDir, socketDir, socketPath, startCommand, stateDir, withProject,
} from '../src/paths.js';

const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const base = { [STATE_KEY]: '/st', [CONFIG_KEY]: '/cfg' };

test('the project key and the name rule', () => {
  assert.equal(PROJECT_KEY, ['KSPROXY', 'PROJECT'].join('_'));
  assert.equal(PROJECT_RULE, '--project: a project name is 1 to 24 characters: lower-case letters, digits, "-" and "_", starting with a letter or a digit');
  assert.equal(PROJECT_RE.test('shop'), true);
  assert.equal(PROJECT_RE.test('Shop'), false);
});

test('no project: every path is today\'s path', () => {
  assert.equal(projectOf(base), null);
  assert.equal(stateDir(base), '/st');
  assert.equal(rootStateDir(base), '/st');
  assert.equal(sessionDir(base), '/st/session');
  assert.equal(socketDir(base), '/st/s');
  assert.equal(logDir(base), '/st/logs');
  assert.equal(projectsDir(base), '/cfg/projects');
  assert.equal(inventoryPath(base), '/cfg/inventory.json');
  assert.equal(rootStateDir({}), path.join(os.homedir(), '.ksproxy'));
});

test('a project has its own state folder and inventory file; the root stays the root', () => {
  const env = withProject(base, 'shop');
  assert.equal(projectOf(env), 'shop');
  assert.equal(stateDir(env), '/st/p/shop');
  assert.equal(rootStateDir(env), '/st');
  assert.equal(sessionDir(env), '/st/p/shop/session');
  assert.equal(socketDir(env), '/st/p/shop/s');
  assert.equal(logDir(env), '/st/p/shop/logs');
  assert.equal(auditLogPath(env), '/st/p/shop/logs/audit.log');
  assert.equal(socketPath('ssh', 'web1', env), '/st/p/shop/s/ssh-web1');
  assert.equal(reviewSocketPath(env), '/st/p/shop/s/review-sock');
  assert.equal(callSocketPath(env), '/st/p/shop/s/call-sock');
  assert.equal(projectsDir(env), '/cfg/projects');
  assert.equal(inventoryPath(env), '/cfg/projects/shop.json');
  assert.equal(stateDir(withProject({}, 'shop')), path.join(os.homedir(), '.ksproxy', 'p', 'shop'));
});

test('withProject removes an inherited value, so only the flag chooses a project', () => {
  const inherited = { ...base, [PROJECT_KEY]: 'ops' };
  assert.equal(projectOf(withProject(inherited, null)), null);
  assert.equal(Object.hasOwn(withProject(inherited, null), PROJECT_KEY), false);
  assert.equal(projectOf(withProject(inherited, 'shop')), 'shop');
  assert.equal(inherited[PROJECT_KEY], 'ops', 'the input is not changed');
  assert.deepEqual(withProject(base, null), base);
});

test('the name default is no project: withProject and projectOf never give it, so no path uses projects/default.json or p/default', () => {
  const inherited = { ...base, [PROJECT_KEY]: 'ops' };
  const env = withProject(inherited, 'default');
  assert.deepEqual(env, withProject(inherited, null));
  assert.equal(Object.hasOwn(env, PROJECT_KEY), false);
  assert.equal(projectOf(env), null);
  const named = { ...base, [PROJECT_KEY]: 'default' };
  assert.equal(projectOf(named), null);
  assert.equal(inventoryPath(named), '/cfg/inventory.json');
  assert.equal(stateDir(named), '/st');
  assert.equal(sessionDir(named), '/st/session');
  assert.equal(callSocketPath(named), '/st/s/call-sock');
  assert.equal(startCommand(named), 'ksproxy start');
  assert.equal(projectOf({ ...base, [PROJECT_KEY]: 'defaults' }), 'defaults');
  assert.equal(stateDir(withProject(base, 'defaults')), '/st/p/defaults');
});

test('a present but invalid project value throws, it never falls back to the default', () => {
  for (const bad of ['', 'Shop', '-a', '_a', 'a'.repeat(25), 'a/b', '..', 'a b', 'a.b', 7, null]) {
    const env = { ...base, [PROJECT_KEY]: bad };
    assert.throws(() => projectOf(env), { message: PROJECT_RULE }, String(bad));
    assert.throws(() => stateDir(env), { message: PROJECT_RULE }, String(bad));
    assert.throws(() => inventoryPath(env), { message: PROJECT_RULE }, String(bad));
    assert.throws(() => sessionDir(env), { message: PROJECT_RULE }, String(bad));
    assert.equal(rootStateDir(env), '/st', 'the root does not depend on the project');
  }
  for (const good of ['a', '0', 'shop-2', 'a_b', 'a-', 'a'.repeat(24)]) {
    assert.equal(projectOf({ ...base, [PROJECT_KEY]: good }), good);
  }
});

test('the commands a message tells the user to run name the project', () => {
  assert.equal(initCommand(base), 'ksproxy init');
  assert.equal(startCommand(base), 'ksproxy start');
  assert.equal(initCommand(withProject(base, 'shop')), 'ksproxy init --project shop');
  assert.equal(startCommand(withProject(base, 'shop')), 'ksproxy start --project shop');
  assert.throws(() => startCommand({ ...base, [PROJECT_KEY]: 'Shop' }), { message: PROJECT_RULE });
});

test('a socket path that is too long names the project as a way out', () => {
  const long = { ...base, [STATE_KEY]: `/${'d'.repeat(70)}` };
  const env = withProject(long, 'a'.repeat(24));
  assert.throws(
    () => socketPath('ssh', 'web1', env),
    /^Error: socket path too long \(109 bytes, limit 83\): \/d+\/p\/a+\/s\/ssh-web1; set KSPROXY_STATE_DIR to a shorter directory or use a shorter project name$/,
  );
  assert.throws(
    () => socketPath('review', 'sock', withProject({ ...base, [STATE_KEY]: `/${'d'.repeat(70)}` }, 'a'.repeat(24))),
    /^Error: socket path too long \(112 bytes, limit 100\): .*; set KSPROXY_STATE_DIR to a shorter directory or use a shorter project name$/,
  );
  assert.doesNotThrow(() => socketPath('ssh', 'web1', long));
  assert.doesNotThrow(() => socketPath('ssh', 'web1', base));
  const tooLong = { ...base, [STATE_KEY]: `/${'x'.repeat(120)}` };
  assert.throws(() => socketPath('ssh', 'web1', tooLong), /; set KSPROXY_STATE_DIR to a shorter directory$/);
});

// A state folder of n bytes, so that the socket of kind and name is exactly bytes long.
const stateFor = (bytes, kind, name) => ({ ...base, [STATE_KEY]: `/${'r'.repeat(bytes - `/s/${kind}-${name}`.length - 1)}` });

test('an ssh master socket leaves 17 bytes for the temporary name ssh binds first: at most 83 bytes, the other sockets 100', () => {
  for (const kind of ['ssh', 'tun']) {
    assert.equal(Buffer.byteLength(socketPath(kind, 'web1', stateFor(83, kind, 'web1'))), 83, kind);
    assert.throws(
      () => socketPath(kind, 'web1', stateFor(84, kind, 'web1')),
      new RegExp(`^Error: socket path too long \\(84 bytes, limit 83\\): /r+/s/${kind}-web1; set KSPROXY_STATE_DIR to a shorter directory$`),
      kind,
    );
  }
  for (const [kind, name] of [['review', 'sock'], ['call', 'sock']]) {
    assert.equal(Buffer.byteLength(socketPath(kind, name, stateFor(100, kind, name))), 100, kind);
    assert.throws(() => socketPath(kind, name, stateFor(101, kind, name)), /^Error: socket path too long \(101 bytes, limit 100\): /, kind);
  }
  // A path that passed the old check of 100 bytes, but that ssh could never bind.
  const env = withProject({ ...base, [STATE_KEY]: `/${'r'.repeat(29)}` }, 'a'.repeat(24));
  assert.throws(() => socketPath('ssh', 'n'.repeat(31), env), /^Error: socket path too long \(95 bytes, limit 83\): .* or use a shorter project name$/);
});
