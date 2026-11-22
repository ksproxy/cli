import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { InventoryError, loadInventory } from '../src/inventory.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';
import { tempDir } from './temp.js';

after(() => cleanupAll());

const SLOW = 'this pattern can be very slow on some inputs';
const HINT = '; in the inventory file a backslash is written twice: \\\\*';

function inventoryFile(text) {
  const dir = fs.realpathSync(tempDir('ks-rc-'));
  const file = path.join(dir, 'inventory.json');
  fs.writeFileSync(file, text);
  return { dir, file };
}

test('loadInventory names the double backslash when a lone backslash before a star breaks the JSON', () => {
  const { dir, file } = inventoryFile('{ "ssh": [{ "name": "a", "host": "h", "allow": ["select \\* from x"] }] }');
  try {
    assert.throws(() => loadInventory(file), (err) => {
      assert.ok(err instanceof InventoryError);
      assert.ok(err.message.startsWith(`inventory ${file} is not valid JSON: `), err.message);
      assert.ok(err.message.endsWith(HINT), err.message);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadInventory adds no hint for other JSON errors, nor for an escaped backslash before a star', () => {
  for (const text of ['{ "ssh": [ }', '{ "ssh": [{ "allow": ["a \\\\* b"] }], }']) {
    const { dir, file } = inventoryFile(text);
    try {
      assert.throws(() => loadInventory(file), (err) => {
        assert.ok(err.message.includes('is not valid JSON: '), err.message);
        assert.ok(!err.message.includes('written twice'), err.message);
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const { dir, file } = inventoryFile('{ "kubernetes": [{ "name": "k", "kubeconfig": "/tmp/k.yaml", "proxyPort": 18555, "allow": ["get pods -l \\\\*"] }] }');
  try {
    assert.deepEqual(loadInventory(file).kubernetes[0].allow, ['get pods -l \\*']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

function checkWorld(inventory) {
  const base = fs.realpathSync(tempDir('ks-rc-'));
  const env = { ...process.env, KSPROXY_CONFIG_DIR: path.join(base, 'cfg'), KSPROXY_STATE_DIR: path.join(base, 'st') };
  fs.mkdirSync(env.KSPROXY_CONFIG_DIR);
  fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify(inventory));
  return { base, env };
}

test('ksproxy check prints the regex rule that allowed a command, and warns first about a slow pattern', async () => {
  const { base, env } = checkWorld({
    ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['regex(uptime)', 'regex((a+)+)', 'df -h', 'regex(\\1)'] }],
    kubernetes: [{ name: 'lab', kubeconfig: '/tmp/none.yaml', proxyPort: 18556, allow: ['regex(get (pods|nodes))'] }],
  });
  try {
    const ok = await cli(['check', 'ssh', 'web1', 'uptime'], env);
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout, 'ALLOWED by rule: regex(uptime)\n');
    assert.equal(ok.stderr, `WARNING: ssh "web1": allow[1]: ${SLOW}\nWARNING: ssh "web1": allow[3]: ${SLOW}\n`);
    const no = await cli(['check', 'ssh', 'web1', 'uptime', '-a'], env);
    assert.equal(no.code, 1);
    assert.match(no.stdout, /^REFUSED: not on the allowlist for this target/);
    assert.ok(no.stderr.startsWith('WARNING: ssh "web1": allow[1]: '));
    const kube = await cli(['check', 'kube', 'lab', 'get', 'nodes'], env);
    assert.equal(kube.code, 0);
    assert.equal(kube.stdout, 'ALLOWED by rule: regex(get (pods|nodes))\n');
    assert.equal(kube.stderr, '');
    const secret = await cli(['check', 'kube', 'lab', 'get', 'secrets'], env);
    assert.equal(secret.code, 1);
    assert.match(secret.stdout, /^REFUSED: /);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ksproxy start warns about a slow pattern after the empty-allow warning and before the target opens', async () => {
  const world = await makeWorld({
    ssh: [],
    local: [{ allow: ['regex(cat (a+)+)', 'ls ...', 'regex(cat \\1)'] }],
  });
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  const err = run.proc.stderr.text;
  const first = err.indexOf(`allow[0]: ${SLOW}\n`);
  const second = err.indexOf(`allow[2]: ${SLOW}\n`);
  const opening = err.indexOf('OPENING');
  assert.ok(first !== -1 && second > first && opening > second, err);
  assert.match(err, /loc {2}infra +WARN +allow\[0\]: this pattern can be very slow on some inputs\n/);
  assert.equal(await stopWith(run), 0);
});
