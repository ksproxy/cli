import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InventoryError, SAMPLE_INVENTORY, validateInventory } from '../src/inventory.js';
import { decideLocal } from '../src/tools.js';

function rejects(raw, pattern) {
  assert.throws(() => validateInventory(raw), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.match(err.message, pattern);
    return true;
  });
}

test('the sample local rules are useful under the flag-free wildcard rule', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-li-')));
  try {
    fs.mkdirSync(path.join(base, 'proj', 'sub'), { recursive: true });
    const env = { KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
    const target = { cwd: path.join(base, 'proj'), allow: SAMPLE_INVENTORY.local[0].allow };
    const ok = (command) => assert.equal(decideLocal(target, command, env).allowed, true, command);
    const no = (command) => assert.equal(decideLocal(target, command, env).allowed, false, command);
    ok('git status');
    ok('git log --oneline -n 20 main..dev');
    ok('git log --oneline -n 5');
    ok('terraform plan');
    ok('ls -l');
    ok('ls -l sub');
    no('git log -p');
    no('git log --oneline -n 20 -C sub');
    no('ls -R sub');
    no('ls -l /etc');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const LOCAL = { name: 'infra', cwd: '/srv/infra', allow: ['git status'] };

test('the sample inventory carries one local target and it is normalised', () => {
  assert.deepEqual(SAMPLE_INVENTORY.local, [{
    name: 'infra',
    cwd: '~/projects/infra',
    description: 'terraform repo',
    allow: ['git status', 'git log --oneline -n * ...', 'terraform plan', 'ls -l ...'],
  }]);
  const inv = validateInventory(SAMPLE_INVENTORY);
  assert.deepEqual(inv.local, [{
    kind: 'local',
    name: 'infra',
    cwd: path.join(os.homedir(), 'projects/infra'),
    description: 'terraform repo',
    allow: ['git status', 'git log --oneline -n * ...', 'terraform plan', 'ls -l ...'],
  }]);
});

test('defaults: allow and description', () => {
  const inv = validateInventory({ local: [{ name: 'a', cwd: '/srv/a' }] });
  assert.deepEqual(inv.local[0], {
    kind: 'local', name: 'a', cwd: '/srv/a', description: '', allow: [],
  });
});

test('an empty inventory has an empty local list, and the folder is tidied', () => {
  assert.deepEqual(validateInventory({}), { ssh: [], kubernetes: [], local: [] });
  assert.equal(validateInventory({ local: [{ name: 'a', cwd: '/srv/a/' }] }).local[0].cwd, '/srv/a');
  assert.equal(validateInventory({ local: [{ name: 'a', cwd: '/srv/b/../a' }] }).local[0].cwd, '/srv/a');
});

test('allowOutsidePaths is no longer accepted, with any value: it is an unknown key like a typo', () => {
  for (const value of [true, false, 'yes', 1, null]) {
    rejects({ local: [{ ...LOCAL, allowOutsidePaths: value }] }, /^local "infra": unknown key "allowOutsidePaths"$/);
  }
});

test('cwd is required, absolute or ~/', () => {
  for (const cwd of [undefined, '', 5]) {
    rejects({ local: [{ name: 'a', cwd }] }, /^local "a": cwd: must be a non-empty path$/);
  }
  rejects({ local: [{ name: 'a', cwd: 'rel/dir' }] }, /^local "a": cwd: must be an absolute path or start with "~\/"$/);
});

test('allow "any" is an inventory error for a local target', () => {
  rejects(
    { local: [{ ...LOCAL, allow: 'any' }] },
    /^local "infra": allow: "any" is not supported for local targets; list the commands$/,
  );
});

test('allow must be an array of valid rules', () => {
  rejects({ local: [{ ...LOCAL, allow: 'all' }] }, /^local "infra": allow: must be an array of rule strings$/);
  rejects({ local: [{ ...LOCAL, allow: ['ls', ''] }] }, /^local "infra": allow\[1\]: rule is empty$/);
  rejects({ local: [{ ...LOCAL, allow: ['ls ... x'] }] }, /^local "infra": allow\[0\]: "\.\.\." is only allowed as the last token/);
});

test('unknown keys and a bad description are errors', () => {
  rejects({ local: [{ ...LOCAL, shell: true }] }, /^local "infra": unknown key "shell"$/);
  rejects({ local: [{ ...LOCAL, host: 'h' }] }, /unknown key "host"/);
  rejects({ local: [{ ...LOCAL, description: 7 }] }, /^local "infra": description: must be a string$/);
});

test('names follow the same rules, are unique within local and may repeat across kinds', () => {
  rejects({ local: [{ ...LOCAL, name: 'Infra' }] }, /^local #0: name: must match/);
  rejects({ local: [LOCAL, { ...LOCAL }] }, /^local "infra": name: duplicate name$/);
  rejects({ local: 'infra' }, /^inventory: local: must be an array$/);
  rejects({ local: [5] }, /^local #0: must be an object$/);
  assert.doesNotThrow(() => validateInventory({
    ssh: [{ name: 'infra', host: 'h' }],
    kubernetes: [{ name: 'infra', kubeconfig: '/k.yaml', proxyPort: 9000 }],
    local: [LOCAL],
  }));
});

test('every local rule must start with the program name: not "*", not "..."', () => {
  rejects({ local: [{ ...LOCAL, allow: ['*'] }] }, /^local "infra": allow\[0\]: a local rule must start with the program name$/);
  rejects({ local: [{ ...LOCAL, allow: ['git status', '* status'] }] }, /^local "infra": allow\[1\]: a local rule must start with the program name$/);
  rejects({ local: [{ ...LOCAL, allow: ['...'] }] }, /^local "infra": allow\[0\]: a local rule must start with the program name$/);
  rejects({ local: [{ ...LOCAL, allow: ['  ... '] }] }, /allow\[0\]: a local rule must start with the program name$/);
  assert.doesNotThrow(() => validateInventory({ local: [{ ...LOCAL, allow: ['git *', 'ls ...', './run.sh', 'venv/bin/python ...'] }] }));
});

test('the program-name rule is for local targets only', () => {
  assert.doesNotThrow(() => validateInventory({ ssh: [{ name: 'a', host: 'h', allow: ['* x', '...'] }] }));
  assert.doesNotThrow(() => validateInventory({ kubernetes: [{ name: 'a', kubeconfig: '/k.yaml', proxyPort: 9000, allow: ['* x', '...'] }] }));
});
