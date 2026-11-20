import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InventoryError, loadInventory, validateInventory } from '../src/inventory.js';

const KUBE = { name: 'lab', kubeconfig: '/tmp/k.yaml', proxyPort: 18001 };

function rejects(raw, pattern) {
  assert.throws(() => validateInventory(raw), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.match(err.message, pattern);
    return true;
  });
}

test('an ssh or kubernetes section that is not an array is rejected by name', () => {
  rejects({ ssh: 'web1' }, /^inventory: ssh: must be an array$/);
  rejects({ kubernetes: {} }, /^inventory: kubernetes: must be an array$/);
});

test('an entry that is not an object is rejected with its position', () => {
  rejects({ ssh: [5] }, /^ssh #0: must be an object$/);
  rejects({ kubernetes: [KUBE, null] }, /^kubernetes #1: must be an object$/);
});

test('a description that is not a string is rejected', () => {
  rejects({ ssh: [{ name: 'a', host: 'h', description: 7 }] }, /^ssh "a": description: must be a string$/);
});

test('a kubeconfig that is missing, empty or not a string is rejected', () => {
  for (const kubeconfig of [undefined, '', 12]) {
    rejects({ kubernetes: [{ ...KUBE, kubeconfig }] }, /kubeconfig: must be a non-empty path/);
  }
});

test('a tunnel that is not an object is rejected', () => {
  rejects({ kubernetes: [{ ...KUBE, tunnel: 'bastion' }] }, /tunnel: must be an object/);
  rejects({ kubernetes: [{ ...KUBE, tunnel: [] }] }, /tunnel: must be an object/);
});

test('a tunnel remote that is missing or not a string is rejected as host:port', () => {
  const tunnel = { host: 'bastion', localPort: 18002 };
  rejects({ kubernetes: [{ ...KUBE, tunnel }] }, /tunnel\.remote: must be host:port/);
  rejects({ kubernetes: [{ ...KUBE, tunnel: { ...tunnel, remote: 6443 } }] }, /tunnel\.remote: must be host:port/);
  rejects({ kubernetes: [{ ...KUBE, tunnel: { ...tunnel, remote: 'h:0' } }] }, /tunnel\.remote: must be host:port/);
  rejects({ kubernetes: [{ ...KUBE, tunnel: { ...tunnel, remote: 'h:70000' } }] }, /tunnel\.remote: must be host:port/);
});

test('manifestRoots must be an array of absolute paths', () => {
  rejects({ kubernetes: [{ ...KUBE, manifestRoots: '/srv' }] }, /manifestRoots: must be an array/);
  rejects({ kubernetes: [{ ...KUBE, manifestRoots: ['relative/dir'] }] }, /manifestRoots\[0\]: must be an absolute path/);
});

test('a valid tunnel and manifest roots are kept', () => {
  const result = validateInventory({
    kubernetes: [{
      ...KUBE,
      tunnel: { host: 'bastion', localPort: 18002, remote: '127.0.0.1:6443' },
      manifestRoots: ['/srv/manifests'],
    }],
  });
  assert.deepEqual(result.kubernetes[0].tunnel, { host: 'bastion', localPort: 18002, remote: '127.0.0.1:6443' });
  assert.deepEqual(result.kubernetes[0].manifestRoots, ['/srv/manifests']);
});

test('loadInventory reports a path that exists but cannot be read as a file', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'ks-ivx-'));
  try {
    assert.throws(() => loadInventory(dir), (err) => {
      assert.ok(err instanceof InventoryError);
      assert.ok(err.message.startsWith(`cannot read inventory ${dir}: `), err.message);
      return true;
    });
    assert.throws(() => loadInventory(path.join(dir, 'none.json')), /inventory not found: .*none\.json; run: ksproxy init/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
