import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vault from './fixtures/kind-brokered.js';
import { KINDS } from '../src/kinds/index.js';
import { callTool } from '../src/tools.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

KINDS.push(vault);
after(() => cleanupAll());

const TOKEN_VAR = 'VAULT_TEST_TOKEN';
const LARGEST = 4096 * 1024;

test('start records the limit of each target from its own inventory, and a full answer at the largest setting reaches the agent', async () => {
  const world = await makeWorld({
    ssh: [{
      name: 'web1', host: 'web1.example.com', allow: ['uptime'], maxOutputKiB: 512,
    }],
    extraEnv: { [TOKEN_VAR]: 'tok-W1d3-unmistakable' },
  });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.vault = [
    {
      name: 'v1', tokenEnv: TOKEN_VAR, allow: ['flood', 'ctl'], maxOutputKiB: 4096,
    },
    { name: 'v2', tokenEnv: TOKEN_VAR, allow: ['flood'] },
  ];
  fs.writeFileSync(file, JSON.stringify(inventory));
  const run = launch(world, { ssh: ['web1'], vault: ['v1', 'v2'] });
  await ready(run);
  assert.ok(!run.proc.stderr.text.includes('KiB'));
  assert.ok(!run.proc.stdout.text.includes('KiB'));

  const session = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
  assert.deepEqual(session.targets.map((t) => [t.name, t.maxOutputKiB]), [['web1', 512], ['v1', 4096], ['v2', undefined]]);
  const agentMd = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.ok(agentMd.includes('- Output is cut at 512 KiB per stream for this target.'));
  assert.ok(agentMd.includes('- Output is cut at 4096 KiB per stream for this target.'));
  // The two lines of the raised targets, and the section on cut output, which names the default, the end part, the
  // cut line of a brokered stream and the 1 KiB that a brokered call that did not end on its own loses.
  assert.equal(agentMd.split('KiB').length, 7);

  // A session file edited by hand does not raise the limit of a brokered target: start keeps its own.
  fs.writeFileSync(path.join(world.sessionDir, 'session.json'), JSON.stringify({
    ...session, targets: session.targets.map((t) => ({ ...t, maxOutputKiB: 4096 })),
  }));

  const flood = await callTool('vault_read', { target: 'v1', command: 'flood' }, world.env);
  assert.equal(flood.isError, false);
  assert.equal(flood.text.split('\n')[3].length, LARGEST);
  assert.ok(flood.text.startsWith('exit code: 0\n[stdout cut at 4 MiB: the rest was left out]\n'));
  const ctl = await callTool('vault_read', { target: 'v1', command: 'ctl' }, world.env);
  assert.equal(ctl.text, `exit code: 0\n[stdout cut at 4 MiB: the rest was left out; showing 2 MiB]\n--- stdout ---\n${'\u0001'.repeat(LARGEST / 2)}`);
  const plain = await callTool('vault_read', { target: 'v2', command: 'flood' }, world.env);
  assert.equal(plain.text.split('\n')[3].length, 262144);
  assert.ok(plain.text.startsWith('exit code: 0\n[stdout cut at 256 KiB: the rest was left out]\n'));
  assert.equal(await stopWith(run), 0);
});
