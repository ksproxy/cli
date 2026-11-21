import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vault from './fixtures/kind-brokered.js';
import { KINDS } from '../src/kinds/index.js';
import { InventoryError, checkSecretVariable } from '../src/checks.js';
import { validateInventory } from '../src/inventory.js';
import { callTool } from '../src/tools.js';
import { writeSession } from '../src/session.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

KINDS.push(vault);
after(() => cleanupAll());

const TOKEN_VAR = 'VAULT_TEST_TOKEN';

async function vaultWorld() {
  const world = await makeWorld({ extraEnv: { [TOKEN_VAR]: 'tok-for-the-audit-test' } });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.vault = [{
    name: 'v1', tokenEnv: TOKEN_VAR, description: 'test vault', allow: ['read *'],
  }];
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.auditFile = path.join(world.env.KSPROXY_STATE_DIR, 'logs', 'audit.log');
  return world;
}

const callsOf = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .filter((e) => e.event === 'call' && e.tool === 'vault_read');

test('the refusals ksproxy mcp makes itself for a brokered kind are audited once, by mcp; a forwarded call once, by start', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const ask = (args) => callTool('vault_read', args, world.env);
  assert.equal((await ask({ target: 'v1', command: 5 })).text, 'invalid arguments: command must be a string');
  assert.equal((await ask({ target: 7, command: 'read a' })).text, 'invalid arguments: target must be a string');
  assert.equal((await ask({ target: 'v1', command: 'read a', timeout_seconds: 0 })).text,
    'invalid arguments: timeout_seconds must be an integer from 1 to 600');
  assert.equal((await ask({ target: 'nope', command: 'read a' })).text, 'unknown vault target "nope". Open targets: v1');
  assert.equal((await ask({ target: 'v1', command: 'read a' })).isError, false);
  assert.equal((await ask({ target: 'v1', command: 'write a' })).isError, true);

  const calls = callsOf(world.auditFile);
  assert.deepEqual(calls.map((e) => [e.target, e.command, e.decision, e.short ?? e.rule, e.kind]), [
    ['v1', null, 'refused', 'invalid arguments', 'vlt'],
    ['7', 'read a', 'refused', 'invalid arguments', 'vlt'],
    ['v1', 'read a', 'refused', 'invalid arguments', 'vlt'],
    ['nope', 'read a', 'refused', 'unknown target', 'vlt'],
    ['v1', 'read a', 'allowed', 'read *', 'vlt'],
    ['v1', 'write a', 'refused', 'not on allowlist', 'vlt'],
  ]);
  assert.equal(calls[3].reason, 'unknown vault target "nope". Open targets: v1');
  await waitFor(() => /vlt +nope +DENIED +read a {2}\[unknown target\]/.test(run.proc.stdout.text), 10000, 'the live line');
  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSED +6 calls: 1 ok, 0 failed, 5 denied/);
});

test('a call socket path that cannot be used is refused and audited by mcp', async () => {
  const world = await vaultWorld();
  const env = { ...world.env, KSPROXY_STATE_DIR: path.join(world.base, 'd'.repeat(90)) };
  const sessionDir = path.join(env.KSPROXY_STATE_DIR, 'session');
  fs.mkdirSync(path.join(env.KSPROXY_STATE_DIR, 'logs'), { recursive: true });
  writeSession(sessionDir, {
    pid: process.pid,
    startedAt: 'now',
    targets: [{
      kind: 'vault', name: 'v1', description: '', allow: ['read *'], state: 'up',
    }],
  });
  assert.deepEqual(await callTool('vault_read', { target: 'v1', command: 'read a' }, env), {
    text: 'REFUSED (vault v1): the session did not answer', isError: true,
  });
  const [entry] = callsOf(path.join(env.KSPROXY_STATE_DIR, 'logs', 'audit.log'));
  assert.equal(entry.decision, 'refused');
  assert.equal(entry.short, 'session did not answer');
  assert.equal(entry.reason, 'the session did not answer');
  assert.equal(entry.command, 'read a');
});

test('checkSecretVariable checks the name of any variable that holds a secret, with the field in the message', () => {
  assert.equal(checkSecretVariable('GRAFANA_TOKEN', 'http "g": auth.bearerEnv'), 'GRAFANA_TOKEN');
  const fails = (value, at, holds, message) => assert.throws(() => checkSecretVariable(value, at, holds), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, message);
    return true;
  });
  const shape = 'must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_';
  for (const value of [undefined, 5, '', 'lower', '1ABC', 'A-B', `A${'B'.repeat(64)}`, 'KSPROXY_X']) {
    fails(value, 'x "y": tokenEnv', undefined, `x "y": tokenEnv: ${shape}`);
  }
  for (const value of ['PATH', 'HOME', 'KUBECONFIG', 'LC_ALL', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'NPM_TOKEN', 'XDG_DATA_HOME']) {
    fails(value, 'x "y": tokenEnv', undefined,
      `x "y": tokenEnv: ${value} is a variable the session needs; name a variable that must hold only the secret`);
  }
  fails('PATH', 'x "y": auth.basicPasswordEnv', 'the password',
    'x "y": auth.basicPasswordEnv: PATH is a variable the session needs; name a variable that must hold only the password');
  assert.throws(() => validateInventory({ reviewers: { r1: { baseUrl: 'https://r.example.com', model: 'm', keyEnv: 'HOME' } } }), {
    message: 'reviewer "r1": keyEnv: HOME is a variable the session needs; name a variable that must hold only the key',
  });
  assert.throws(() => validateInventory({ vault: [{ name: 'v', tokenEnv: 'PATH' }] }), {
    message: 'vault "v": tokenEnv: PATH is a variable the session needs; name a variable that must hold only the token',
  });
});

test('a call whose audited form cannot be made is refused and still audited by mcp, with no error text', async () => {
  const shaped = {
    ...vault,
    key: 'ovault',
    flag: 'ovault',
    label: 'ovlt',
    word: 'ovault',
    noun: 'ovault target',
    tool: {
      name: 'ovault_call',
      nameKey: 'target',
      detailKey: 'request',
      detailIsArray: false,
      detailShape: 'object',
      auditedDetail() {
        throw new Error('cannot show /secret/path');
      },
      definition: {},
    },
  };
  KINDS.push(shaped);
  try {
    const world = await vaultWorld();
    const { env } = world;
    const stateDir = env[['KSPROXY', 'STATE', 'DIR'].join('_')];
    writeSession(path.join(stateDir, 'session'), {
      pid: process.pid,
      startedAt: 'now',
      targets: [{
        kind: 'ovault', name: 'o1', description: '', allow: ['read *'], state: 'up',
      }],
    });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    assert.deepEqual(await callTool('ovault_call', { target: 'o1', path: 'x' }, env), {
      text: 'invalid arguments: the call could not be written to the log', isError: true,
    });
    const entries = fs.readFileSync(world.auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const entry = entries.at(-1);
    assert.deepEqual([entry.event, entry.tool, entry.kind, entry.target, entry.request, entry.decision, entry.short], [
      'call', 'ovault_call', 'ovlt', 'o1', null, 'refused', 'invalid arguments',
    ]);
    assert.ok(!JSON.stringify(entries).includes('/secret/path'));
  } finally {
    KINDS.splice(KINDS.indexOf(shaped), 1);
  }
});
