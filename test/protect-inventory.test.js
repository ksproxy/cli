import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryError, validateInventory } from '../src/inventory.js';

const LOCAL = { name: 'infra', cwd: '/srv/infra', allow: ['git status'] };
const withProtect = (protect) => ({ local: [{ ...LOCAL, protect }] });

function rejects(raw, pattern) {
  assert.throws(() => validateInventory(raw), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.match(err.message, pattern);
    return true;
  });
}

test('a local target without protect has no protect key', () => {
  const [t] = validateInventory({ local: [LOCAL] }).local;
  assert.equal(Object.hasOwn(t, 'protect'), false);
});

test('protect entries are cleaned and kept in order', () => {
  const [t] = validateInventory(withProtect(['secrets', './deploy//key.txt', 'my notes.txt', 'a/./b/'])).local;
  assert.deepEqual(t.protect, ['secrets', 'deploy/key.txt', 'my notes.txt', 'a/b']);
});

test('protect must be a list of 1 to 50 entries', () => {
  for (const bad of ['secrets', {}, [], Array.from({ length: 51 }, (_, i) => `f${i}`)]) {
    rejects(withProtect(bad), /infra.*protect: must be a list of 1 to 50 paths inside the folder/);
  }
  assert.equal(validateInventory(withProtect(Array.from({ length: 50 }, (_, i) => `f${i}`))).local[0].protect.length, 50);
});

test('each entry is a path of 1 to 512 bytes without control characters', () => {
  for (const bad of [7, '', 'a'.repeat(513), 'a\nb', 'a\u007fb']) {
    rejects(withProtect(['ok', bad]), /infra.*protect\[1\]: must be a path of 1 to 512 bytes without control characters/);
  }
  assert.equal(validateInventory(withProtect(['a'.repeat(512)])).local[0].protect[0].length, 512);
});

test('an entry is relative to the folder and stays inside it', () => {
  rejects(withProtect(['/etc/hosts']), /protect\[0\]: must be relative to the folder/);
  rejects(withProtect(['~/x']), /protect\[0\]: must be relative to the folder/);
  rejects(withProtect(['a/../b']), /protect\[0\]: may not contain "\.\."/);
  rejects(withProtect(['..']), /protect\[0\]: may not contain "\.\."/);
  for (const self of ['.', './', './/.']) rejects(withProtect([self]), /protect\[0\]: names the folder itself/);
});

test('an entry may not be listed twice, also in another spelling', () => {
  rejects(withProtect(['secrets', './secrets/']), /protect\[1\]: secrets is listed twice/);
});

test('protect is an unknown key on the other kinds of target', () => {
  rejects({ ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['uptime'], protect: ['x'] }] }, /protect/);
});
