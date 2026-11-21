import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InventoryError, SAMPLE_INVENTORY, validateInventory, loadInventory } from '../src/inventory.js';

const clone = () => structuredClone(SAMPLE_INVENTORY);

function bad(mutate, pattern) {
  const inv = clone();
  mutate(inv);
  assert.throws(
    () => validateInventory(inv),
    (err) => err instanceof InventoryError && pattern.test(err.message),
    pattern.toString(),
  );
}

function kubeEntry(name, proxyPort, extra = {}) {
  return { name, kubeconfig: '/k.yaml', proxyPort, ...extra };
}

test('sample inventory is valid and normalised', () => {
  const inv = validateInventory(SAMPLE_INVENTORY);
  assert.equal(inv.ssh.length, 1);
  assert.equal(inv.kubernetes.length, 1);
  assert.deepEqual(inv.ssh[0], {
    kind: 'ssh',
    name: 'web1',
    host: 'web1.example.com',
    description: 'production web box',
    allow: ['systemctl status *', 'journalctl -u myapp ...', 'df -h'],
  });
  const kube = inv.kubernetes[0];
  assert.equal(kube.kind, 'kubernetes');
  assert.equal(kube.kubeconfig, path.join(os.homedir(), '.kube/lab-agent.yaml'));
  assert.deepEqual(kube.manifestRoots, [path.join(os.homedir(), 'projects/lab/manifests')]);
  assert.deepEqual(kube.tunnel, { host: 'bastion.example.com', localPort: 16443, remote: '127.0.0.1:6443' });
  assert.equal(kube.proxyPort, 8001);
});

test('defaults: allow, description, manifestRoots, tunnel', () => {
  const inv = validateInventory({
    ssh: [{ name: 'a', host: 'h' }],
    kubernetes: [kubeEntry('k', 9000)],
  });
  assert.deepEqual(inv.ssh[0].allow, []);
  assert.equal(inv.ssh[0].description, '');
  assert.deepEqual(inv.kubernetes[0].allow, []);
  assert.deepEqual(inv.kubernetes[0].manifestRoots, []);
  assert.equal(inv.kubernetes[0].tunnel, null);
});

test('allow "any" is preserved', () => {
  const inv = validateInventory({ ssh: [{ name: 'a', host: 'h', allow: 'any' }] });
  assert.equal(inv.ssh[0].allow, 'any');
});

test('empty and ssh-only inventories', () => {
  assert.deepEqual(validateInventory({}), {
    ssh: [], kubernetes: [], local: [], reviewers: {},
  });
  const inv = validateInventory({ ssh: [{ name: 'a', host: 'h' }] });
  assert.deepEqual(inv.kubernetes, []);
});

test('top level must be an object', () => {
  assert.throws(() => validateInventory([]), InventoryError);
});

test('unknown keys are errors', () => {
  bad((inv) => { inv.extra = 1; }, /extra/);
  bad((inv) => { inv.ssh[0].alow = []; }, /alow/);
  bad((inv) => { inv.kubernetes[0].tunnel.bogus = 1; }, /bogus/);
});

test('name rules', () => {
  bad((inv) => { inv.ssh[0].name = 'Web1'; }, /name/);
  bad((inv) => { inv.ssh[0].name = '-x'; }, /name/);
  bad((inv) => { inv.ssh[0].name = 'a'.repeat(32); }, /name/);
  bad((inv) => { inv.ssh.push({ ...inv.ssh[0] }); }, /duplicate/);
});

test('same name is allowed across kinds', () => {
  assert.doesNotThrow(() => validateInventory({
    ssh: [{ name: 'x', host: 'h' }],
    kubernetes: [kubeEntry('x', 9000)],
  }));
});

test('host rules', () => {
  bad((inv) => { inv.ssh[0].host = '-oProxyCommand=x'; }, /host/);
  bad((inv) => { delete inv.ssh[0].host; }, /host/);
  bad((inv) => { inv.kubernetes[0].tunnel.host = '-bad'; }, /tunnel\.host/);
});

test('port rules', () => {
  bad((inv) => { inv.kubernetes[0].proxyPort = 80; }, /proxyPort/);
  bad((inv) => { inv.kubernetes[0].proxyPort = 70000; }, /proxyPort/);
  bad((inv) => { inv.kubernetes[0].proxyPort = '8001'; }, /proxyPort/);
  bad((inv) => { inv.kubernetes.push(kubeEntry('k2', 8001)); }, /proxyPort/);
  bad((inv) => { inv.kubernetes.push(kubeEntry('k2', 16443)); }, /proxyPort/);
  bad((inv) => { inv.kubernetes.push(kubeEntry('k2', 9000, { tunnel: { host: 'h', localPort: 8001, remote: 'a:1' } })); }, /localPort/);
});

test('tunnel.remote rule', () => {
  bad((inv) => { inv.kubernetes[0].tunnel.remote = 'nohost'; }, /tunnel\.remote/);
});

test('allow rules', () => {
  bad((inv) => { inv.ssh[0].allow = 'all'; }, /allow/);
  bad((inv) => { inv.ssh[0].allow = ['']; }, /allow\[0\]/);
  bad((inv) => { inv.ssh[0].allow = ['df -h', 'get ... pods']; }, /allow\[1\].*"\.\.\." is only allowed as the last token/);
  bad((inv) => { inv.kubernetes[0].allow = ['get ... pods']; }, /allow\[0\]/);
});

test('kubeconfig must be absolute', () => {
  bad((inv) => { inv.kubernetes[0].kubeconfig = 'kube.yaml'; }, /kubeconfig/);
  bad((inv) => { inv.kubernetes[0].manifestRoots = ['rel/dir']; }, /manifestRoots\[0\]/);
});

test('errors name the kind and entry', () => {
  bad((inv) => { inv.ssh[0].host = '-x'; }, /ssh "web1": host/);
  bad((inv) => { inv.kubernetes[0].proxyPort = 80; }, /kubernetes "lab": proxyPort/);
});

test('loadInventory', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'ks-inv-'));
  const file = path.join(dir, 'inventory.json');
  assert.throws(
    () => loadInventory(file),
    (err) => err instanceof InventoryError && err.message.includes('ksproxy init'),
  );
  fs.writeFileSync(file, '{ not json');
  assert.throws(
    () => loadInventory(file),
    (err) => err instanceof InventoryError && err.message.includes('not valid JSON'),
  );
  fs.writeFileSync(file, JSON.stringify(SAMPLE_INVENTORY));
  assert.equal(loadInventory(file).ssh[0].name, 'web1');
  fs.writeFileSync(file, JSON.stringify({ nope: 1 }));
  assert.throws(() => loadInventory(file), InventoryError);
});

test('tunnel.remote port must be 1 to 65535', () => {
  bad((inv) => { inv.kubernetes[0].tunnel.remote = 'h:0'; }, /tunnel\.remote/);
  bad((inv) => { inv.kubernetes[0].tunnel.remote = 'h:70000'; }, /tunnel\.remote/);
  bad((inv) => { inv.kubernetes[0].tunnel.remote = 'h:65536'; }, /tunnel\.remote/);
  const inv = clone();
  inv.kubernetes[0].tunnel.remote = 'h:65535';
  assert.doesNotThrow(() => validateInventory(inv));
});
